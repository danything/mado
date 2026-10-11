// 静的チャネル(drdynvc / cliprdr)を RdpClient に結びつける。drdynvc の上に DisplayControl を載せる。

import type { RdpClient } from "./client";
import { Clipboard } from "./cliprdr";
import { DISPLAYCONTROL, DisplayControl, DynamicChannels } from "./dvc";

export type Channels = {
	displayControl: DisplayControl;
	clipboard: Clipboard;
};

/** onRemoteText は、サーバー側でコピーされた文字列。ブラウザのクリップボードへ入れるのは呼び出し側 */
export function attachChannels(
	client: RdpClient,
	onRemoteText: (text: string) => void,
): Channels {
	const dvc = new DynamicChannels((data) =>
		client.sendChannel("drdynvc", data),
	);
	const displayControl = new DisplayControl();
	dvc.register(DISPLAYCONTROL, displayControl);
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
