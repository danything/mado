// Talos のダッシュボード(talosctl dashboard)。mado が talosctl を擬似端末(ConPTY)で動かし、その入出力を /ws/talos で中継する。
// 画面は SOL と同じ見た目の端末(xterm.js。talos/view.ts)に出す。最初のテキストのメッセージで使い捨てのトークンと端末の大きさを送り、
// あとはバイナリがキー入力と画面、テキストの {"cols","rows"} が大きさの変更。動かすコマンドは mado.json だけで決まる。

/** 最初のメッセージ */
export function helloMessage(
  token: string,
  cols: number,
  rows: number,
): string {
  return JSON.stringify({ token, cols, rows });
}

/** 端末の大きさが変わったとき */
export function resizeMessage(cols: number, rows: number): string {
  return JSON.stringify({ cols, rows });
}

/** 期限がこの日数を切ったら、バーで知らせる */
export const EXPIRY_WARN_DAYS = 14;

/** talosconfig の期限の知らせ。まだ先なら undefined */
export function expiryNote(
  notAfter: string | undefined,
  now: Date,
): { text: string; kind: "warn" | "error" } | undefined {
  if (!notAfter) return undefined;
  const until = new Date(notAfter).getTime();
  if (Number.isNaN(until)) return undefined;
  const days = Math.floor((until - now.getTime()) / 86_400_000);
  if (until <= now.getTime())
    return {
      text: "Talos の証明書の期限が切れています。gitops の mado/setup.ps1 を流し直してください",
      kind: "error",
    };
  if (days < EXPIRY_WARN_DAYS)
    return {
      text: `Talos の証明書はあと ${days} 日で切れます。gitops の mado/setup.ps1 を流し直してください`,
      kind: "warn",
    };
  return undefined;
}

/** mado が閉じた理由(短い英語)を、次にすることが分かる文にする */
export function explainDashboardError(reason: string): string {
  const exited = /^exited (-?\d+)$/.exec(reason);
  if (exited)
    return exited[1] === "0"
      ? "ダッシュボードを終了しました"
      : `talosctl が終了しました(終了コード ${exited[1]})。証明書の期限が切れていないか、ノードに届くかを確かめてください`;
  switch (reason) {
    case "token rejected":
      return "この先ではダッシュボードを使えません。mado.json の先の type が talos か確かめてください";
    case "talosctl not found":
      return "talosctl.exe が見つかりません。mado.json の talos の先の talosctl に場所を書くか、PATH に置いてください";
    case "talosconfig unreadable":
      return "talosconfig を開けません。gitops の mado/setup.ps1 を流し直してください";
    case "busy":
      return "開いているダッシュボードが多すぎます。ほかを閉じてから開いてください";
    case "not supported":
      return "この mado は Windows で動いていないため、ダッシュボードを使えません";
    case "start failed":
      return "talosctl を起動できませんでした。mado.log を確かめてください";
    case "":
    case "closed":
      return "ダッシュボードを終了しました";
    default:
      return reason;
  }
}

/** Talos の電源の操作(POST /api/talos/<名前>/<key>)。mado は talosctl shutdown / reboot --wait=false を動かす */
export type TalosPowerAction = {
  key: "shutdown" | "reboot";
  label: string;
  description: string;
};

export const TALOS_POWER: TalosPowerAction[] = [
  {
    key: "shutdown",
    label: "シャットダウン",
    description: "Talos が止める準備をしてから電源を切ります",
  },
  {
    key: "reboot",
    label: "再起動",
    description: "Talos が止める準備をしてから再起動します",
  },
];

/** /api/talos/<名前>/<操作> の返事。reason は失敗の短い英語、detail は talosctl が最後に書いた行 */
export type TalosPowerResult = {
  ok: boolean;
  reason?: string;
  detail?: string;
};

/** 電源の操作の結果を、バーに出す文にする */
export function explainPowerResult(
  action: TalosPowerAction,
  r: TalosPowerResult,
): { text: string; kind: "ok" | "error" } {
  if (r.ok)
    return {
      text: `${action.label}を受け付けました。Talos が止める準備をしています`,
      kind: "ok",
    };
  const detail = r.detail ?? "";
  let why: string;
  if (/PermissionDenied|not authorized/i.test(detail))
    why =
      "鍵に権限がありません(os:operator が要ります)。gitops の mado/setup.ps1 を流し直してください";
  else if (r.reason === "busy")
    why = "ほかの電源の操作が動いています。終わってから押してください";
  else if (r.reason === "timeout") why = "talosctl が 60 秒たっても返りません";
  else if (r.reason === "not supported")
    why = "この mado は Windows で動いていないため、talosctl を動かせません";
  else if (r.reason && /^exited -?\d+$/.test(r.reason))
    why = detail || `talosctl が終了しました(${r.reason})`;
  else why = explainDashboardError(r.reason ?? "");
  return { text: `${action.label}できませんでした: ${why}`, kind: "error" };
}

/** WebSocket のうち使うところ。試験では偽物を渡す */
export type DashSocket = {
  binaryType: BinaryType;
  readonly readyState: number;
  send(data: string | Uint8Array<ArrayBuffer>): void;
  close(): void;
  addEventListener(type: "open" | "error", f: () => void): void;
  addEventListener(type: "close", f: (e: { reason: string }) => void): void;
  addEventListener(type: "message", f: (e: { data: unknown }) => void): void;
};

export class DashboardSession {
  /** 画面に出すバイト */
  onData?: (b: Uint8Array) => void;
  /** 閉じたら、閉じた理由(mado の短い英語)で解決する */
  readonly done: Promise<string>;
  private finish!: (reason: string) => void;

  private constructor(private readonly ws: DashSocket) {
    this.done = new Promise((r) => {
      this.finish = r;
    });
    ws.addEventListener("message", (e) => {
      if (e.data instanceof ArrayBuffer) this.onData?.(new Uint8Array(e.data));
    });
    ws.addEventListener("close", (e) => this.finish(e.reason));
  }

  /** つないで、最初のメッセージを送る。つながらなければ例外 */
  static open(
    url: string,
    token: string,
    cols: number,
    rows: number,
    make: (url: string) => DashSocket = (u) => new WebSocket(u),
  ): Promise<DashboardSession> {
    return new Promise((resolve, reject) => {
      const ws = make(url);
      ws.binaryType = "arraybuffer";
      const session = new DashboardSession(ws);
      ws.addEventListener("open", () => {
        ws.send(helloMessage(token, cols, rows));
        resolve(session);
      });
      ws.addEventListener("error", () =>
        reject(new Error(`cannot open ${url}`)),
      );
    });
  }

  send(b: Uint8Array): void {
    if (this.ws.readyState === 1) this.ws.send(b as Uint8Array<ArrayBuffer>);
  }

  resize(cols: number, rows: number): void {
    if (this.ws.readyState === 1) this.ws.send(resizeMessage(cols, rows));
  }

  /** こちらから閉じる。mado が talosctl を止める */
  close(): void {
    this.ws.close();
  }
}
