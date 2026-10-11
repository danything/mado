// この PC の中からだけ見られる状態の口(既定 http://127.0.0.1:8788)。動いているか・版・更新の有無を手元で見る。
//
//   GET  /status  版・起動時刻・つないでいる数・証明書の残り日数・更新の有無(秘密は出さない)
//   POST /update  今すぐ新しい版を確かめ、誰もつないでいなければ入れ替える
//
// ほかのサイトのページから叩かせないために 2 つ確かめる。
// - Host が 127.0.0.1 / localhost であること(DNS リバインディングで、よその名前のまま 127.0.0.1 に来るのを弾く)
// - POST には `x-mado: 1` のヘッダー(ヘッダーを足すと CORS の事前確認が要り、それには答えない)

import type { UpdateState } from "./update.ts";

export type Status = {
	version: string;
	origin: string;
	startedAt: string;
	sessions: number;
	certDaysLeft: number | null;
	update: UpdateState;
};

export function serveStatus(
	port: number,
	status: () => Status,
	updateNow: () => Promise<{ updated: boolean; state: UpdateState }>,
) {
	// port に 0 を渡したとき(試験)は、実際に開いた番号で見る
	const local = (req: Request): boolean => {
		const p: number | undefined = server.port;
		return [`127.0.0.1:${p}`, `localhost:${p}`].includes(
			req.headers.get("host") ?? "",
		);
	};
	const forbidden = (why: string) => new Response(why, { status: 403 });
	const server: Bun.Server<undefined> = Bun.serve({
		hostname: "127.0.0.1",
		port,
		routes: {
			"/status": (req) =>
				local(req)
					? Response.json(status(), {
							headers: { "cache-control": "no-store" },
						})
					: forbidden("host が違う"),
			"/update": {
				POST: async (req) => {
					if (!local(req)) return forbidden("host が違う");
					if (req.headers.get("x-mado") !== "1")
						return forbidden("x-mado: 1 が要る");
					return Response.json(await updateNow());
				},
			},
		},
		fetch: () => new Response("not found", { status: 404 }),
	});
	return server;
}
