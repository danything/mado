// つなぐ先ごとに保存するユーザー名とパスワード(AMT と RDP)。保存は「この端末に保存する」を選んでつながったときだけ。
// 置くのはこのブラウザの IndexedDB だけで、mado のサーバーには送らない(mado はパスワードを受け取らない作りのまま)。
// そのままは置かない。WebCrypto で取り出せない(extractable: false)AES-GCM の鍵を作って IndexedDB に置き、
// その鍵で暗号化したものを IndexedDB に置く。
// 守れるのは「プロファイルのファイルを読まれても、平文のパスワードは出てこない」まで。
// 同じブラウザでこのページを開ける人と、ページに入り込んだスクリプトは、鍵を使って読める。

/** 同じ PC でも AMT と RDP は別に持つ */
export type LoginKind = "amt" | "rdp";
export type SavedLogin = { username: string; password: string };

const DB = "mado-logins";
/** 鍵(CryptoKey をそのまま置く。取り出せない鍵も IndexedDB には置ける) */
const KEYS = "keys";
const KEY_ID = "logins";
/** 暗号化したもの。キーは「種類:つなぐ先の名前」 */
const LOGINS = "logins";

type Sealed = { iv: Uint8Array<ArrayBuffer>; data: ArrayBuffer };

export type VaultEnv = { indexedDB?: IDBFactory; subtle?: SubtleCrypto };

const idOf = (kind: LoginKind, target: string) => `${kind}:${target}`;
const enc = new TextEncoder();

const request = <T>(r: IDBRequest<T>) =>
  new Promise<T>((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });

/** 書き終わる(commit)まで待つ */
const committed = (t: IDBTransaction) =>
  new Promise<void>((resolve, reject) => {
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });

function openDb(idb: IDBFactory): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const r = idb.open(DB, 1);
    r.onupgradeneeded = () => {
      r.result.createObjectStore(KEYS);
      r.result.createObjectStore(LOGINS);
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.onblocked = () => reject(new Error("IndexedDB を開けない"));
  });
}

export class LoginVault {
  private constructor(
    private readonly db: IDBDatabase,
    private readonly subtle: SubtleCrypto,
  ) {}

  /**
   * 保存の場所を開く。IndexedDB か WebCrypto が使えなければ undefined
   * (プライベートウィンドウ、http の先、サイトのデータを止めた設定など)。そのときは保存のチェックを出さない
   */
  static async open(env?: VaultEnv): Promise<LoginVault | undefined> {
    try {
      const idb = env ? env.indexedDB : globalThis.indexedDB;
      const subtle = env ? env.subtle : globalThis.crypto?.subtle;
      if (!idb || !subtle) return undefined;
      return new LoginVault(await openDb(idb), subtle);
    } catch {
      return undefined;
    }
  }

  /**
   * 暗号化の鍵。create なら、無ければ作る。
   * 鍵を作るのは IndexedDB の外(await の間に transaction が終わるため)。
   * 置く前にもう一度読み、ほかのタブが先に置いていたらそれを使う(別々の鍵で書いて読めなくならないように)
   */
  private async key(create: boolean): Promise<CryptoKey | undefined> {
    const found = (await request(
      this.db.transaction(KEYS).objectStore(KEYS).get(KEY_ID),
    )) as CryptoKey | undefined;
    if (found || !create) return found;
    const made = await this.subtle.generateKey(
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"],
    );
    const t = this.db.transaction(KEYS, "readwrite");
    const store = t.objectStore(KEYS);
    const done = committed(t);
    const raced = (await request(store.get(KEY_ID))) as CryptoKey | undefined;
    if (!raced) store.put(made, KEY_ID);
    await done;
    return raced ?? made;
  }

  /** 保存したもの。無いとき、読めないとき(鍵が無い、中身が壊れている)は undefined */
  async load(kind: LoginKind, target: string): Promise<SavedLogin | undefined> {
    const id = idOf(kind, target);
    const sealed = (await request(
      this.db.transaction(LOGINS).objectStore(LOGINS).get(id),
    )) as Sealed | undefined;
    if (!sealed) return undefined;
    try {
      const key = await this.key(false);
      if (!key) return undefined;
      // 追加の認証データに「種類:つなぐ先」を入れる。ほかの先の中身を持ってきても開かない
      const plain = await this.subtle.decrypt(
        { name: "AES-GCM", iv: sealed.iv, additionalData: enc.encode(id) },
        key,
        sealed.data,
      );
      const v = JSON.parse(new TextDecoder().decode(plain)) as SavedLogin;
      if (typeof v.username !== "string" || typeof v.password !== "string")
        return undefined;
      return { username: v.username, password: v.password };
    } catch {
      return undefined;
    }
  }

  /** 保存する。前のものがあれば上書きする。できなければ例外 */
  async save(
    kind: LoginKind,
    target: string,
    login: SavedLogin,
  ): Promise<void> {
    const id = idOf(kind, target);
    const key = (await this.key(true)) as CryptoKey;
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const data = await this.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: enc.encode(id) },
      key,
      enc.encode(
        JSON.stringify({ username: login.username, password: login.password }),
      ),
    );
    const t = this.db.transaction(LOGINS, "readwrite");
    t.objectStore(LOGINS).put({ iv, data } satisfies Sealed, id);
    await committed(t);
  }

  /** その先の保存を消す */
  async remove(kind: LoginKind, target: string): Promise<void> {
    const t = this.db.transaction(LOGINS, "readwrite");
    t.objectStore(LOGINS).delete(idOf(kind, target));
    await committed(t);
  }

  /** 一覧に無くなった先の保存を消す(消す操作を出す場所が無くなるので、残さない) */
  async prune(keep: [LoginKind, string][]): Promise<void> {
    const ids = new Set(keep.map(([kind, target]) => idOf(kind, target)));
    const t = this.db.transaction(LOGINS, "readwrite");
    const store = t.objectStore(LOGINS);
    const done = committed(t);
    for (const id of await request(store.getAllKeys()))
      if (!ids.has(String(id))) store.delete(id);
    await done;
  }

  /** 保存したものと鍵をすべて消す(ログアウトのとき) */
  async clear(): Promise<void> {
    const t = this.db.transaction([KEYS, LOGINS], "readwrite");
    t.objectStore(LOGINS).clear();
    t.objectStore(KEYS).clear();
    await committed(t);
  }
}
