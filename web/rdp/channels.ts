// 静的チャネルの drdynvc と cliprdr を RdpClient に結びつける。drdynvc の上には DisplayControl を載せ、GFX を使うときは GFX も載せる。

import type { RdpClient } from "./client";
import { Clipboard } from "./cliprdr";
import { DISPLAYCONTROL, DisplayControl, DynamicChannels } from "./dvc";
import { type GfxClient, GRAPHICS } from "./gfx";

export type Channels = {
	displayControl: DisplayControl;
	clipboard: Clipboard;
};

/** onRemoteText はサーバー側でコピーされた文字列を受ける。ブラウザのクリップボードへは呼び出し側が入れる */
export function attachChannels(
	client: RdpClient,
	onRemoteText: (text: string) => void,
	/** GFX(H.264)の受け手。connect で gfx を指定したときに渡す */
	options: { gfx?: GfxClient } = {},
): Channels {
	const dvc = new DynamicChannels((data) =>
		client.sendChannel("drdynvc", data),
	);
	const displayControl = new DisplayControl();
	dvc.register(DISPLAYCONTROL, displayControl);
	if (options.gfx) dvc.register(GRAPHICS, options.gfx);
	const clipboard = new Clipboard(
		(data) => client.sendChannel("cliprdr", data),
		onRemoteText,
	);
	client.onChannel = (name, data) => {
		if (name === "drdynvc") dvc.onStatic(data);
		else if (name === "cliprdr") clipboard.onStatic(data);
	};
	return { displayControl, clipboard };
}
