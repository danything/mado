// mado が新しい版に上がったのに、開いたままのページが古いスクリプトで動き続けるのを防ぐ。
// ハッシュ入りのファイルと no-cache の index.html(server/WebAssets.cs)で、読み直せば新しい版になる。
// ただ、開いたままのタブ(Android では裏に回したタブも)は読み直さないので、サーバーの版を時々聞いて、違えば読み直す。
// つないでいる間や、パスワードを入れかけている間は読み直さず、知らせるだけにする。

/** 見えている間、サーバーの版を聞く間隔 */
export const CHECK_MS = 5 * 60_000;

export type StaleDeps = {
  /** ページを読み込んだときのサーバーの版 */
  loaded: string;
  /** いまのサーバーの版。聞けなければ undefined(更新で止まっている間など) */
  fetchVersion: () => Promise<string | undefined>;
  /** いま読み直してよいか(つないでいない、入れかけたものが無い) */
  idle: () => boolean;
  reload: () => void;
  /** 読み直せないとき、新しい版があることを知らせる */
  notify: (latest: string) => void;
  /** 見えているか。既定は document.visibilityState */
  visible?: () => boolean;
  /** visibilitychange・pageshow・online を受ける先。既定は window(document の visibilitychange も泡立って届く) */
  events?: Pick<EventTarget, "addEventListener" | "removeEventListener">;
  setInterval?: (fn: () => void, ms: number) => unknown;
  clearInterval?: (id: unknown) => void;
};

export type StaleWatch = {
  /** いますぐ確かめる。つないだあと画面に戻ったときなどに呼ぶ */
  check(): Promise<void>;
  stop(): void;
};

export function watchStale(deps: StaleDeps): StaleWatch {
  const visible =
    deps.visible ?? (() => document.visibilityState === "visible");
  const events: Pick<EventTarget, "addEventListener" | "removeEventListener"> =
    deps.events ?? window;
  const every = deps.setInterval ?? ((fn, ms) => setInterval(fn, ms));
  const clear =
    deps.clearInterval ??
    ((id) => clearInterval(id as ReturnType<typeof setInterval>));
  /** 新しいと分かった版。読み直せるときを待っている */
  let latest: string | undefined;
  let busy = false;

  const check = async () => {
    if (busy) return;
    busy = true;
    try {
      const v = latest ?? (await deps.fetchVersion().catch(() => undefined));
      if (!v || v === deps.loaded) return;
      if (deps.idle()) {
        deps.reload();
        return;
      }
      if (latest !== v) deps.notify(v);
      latest = v;
    } finally {
      busy = false;
    }
  };
  const onEvent = () => {
    if (visible()) void check();
  };
  // 裏から戻ったとき、戻る・進むでキャッシュから出たとき(pageshow)、回線が戻ったとき
  events.addEventListener("visibilitychange", onEvent);
  events.addEventListener("pageshow", onEvent);
  events.addEventListener("online", onEvent);
  const timer = every(onEvent, CHECK_MS);
  return {
    check,
    stop() {
      events.removeEventListener("visibilitychange", onEvent);
      events.removeEventListener("pageshow", onEvent);
      events.removeEventListener("online", onEvent);
      clear(timer);
    },
  };
}
