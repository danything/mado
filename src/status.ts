// この PC の中からだけ見られる状態の口(既定 http://127.0.0.1:8788)。動いているか・版・更新の有無を手元で見る。
//
//   GET  /status  版・起動時刻・つないでいる数・証明書の残り日数・更新の有無(秘密は出さない)
//   POST /update  今すぐ新しい版を確かめ、誰もつないでいなければ入れ替える
//
// ブラウザのページから 127.0.0.1 に投げられないように、POST には `x-mado: 1` のヘッダーを求める
// (ヘッダーを足すと CORS の事前確認が要り、それには答えないので、ほかのサイトのページからは届かない)。

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
	return Bun.serve({
		hostname: "127.0.0.1",
		port,
		routes: {
			"/status": () =>
				Response.json(status(), { headers: { "cache-control": "no-store" } }),
			"/update": {
				POST: async (req) => {
					if (req.headers.get("x-mado") !== "1")
						return new Response("x-mado: 1 が要る", { status: 403 });
					return Response.json(await updateNow());
				},
			},
		},
		fetch: () => new Response("not found", { status: 404 }),
	});
}
