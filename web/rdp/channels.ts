// 静的チャネルの drdynvc と cliprdr を RdpClient に結びつける。drdynvc の上には DisplayControl を載せ、GFX を使うときは GFX も、
// 指で触れる端末ではタッチの入力(rdpei.ts)も載せる。

import type { RdpClient } from "./client";
import { Clipboard } from "./cliprdr";
import { DISPLAYCONTROL, DisplayControl, DynamicChannels } from "./dvc";
import { type GfxClient, GRAPHICS } from "./gfx";
import { INPUT, TouchInput } from "./rdpei";

export type Channels = {
  displayControl: DisplayControl;
  clipboard: Clipboard;
  /** タッチの入力。options.touch が 0 のときは無い */
  touch?: TouchInput;
};

/** onRemoteText はサーバー側でコピーされた文字列を受ける。ブラウザのクリップボードへは呼び出し側が入れる */
export function attachChannels(
  client: RdpClient,
  onRemoteText: (text: string) => void,
  options: {
    /** GFX の受け手。connect で gfx を指定したときに渡す */
    gfx?: GfxClient;
    /**
     * 同時に触れられる指の数(navigator.maxTouchPoints)。1 以上ならタッチの入力のチャネルを受ける。
     * 仕様([MS-RDPEI] 3.3.3)のとおり、タッチの無い端末ではチャネルを開かない
     */
    touch?: number;
  } = {},
): Channels {
  const dvc = new DynamicChannels((data) =>
    client.sendChannel("drdynvc", data),
  );
  const displayControl = new DisplayControl();
  dvc.register(DISPLAYCONTROL, displayControl);
  if (options.gfx) dvc.register(GRAPHICS, options.gfx);
  let touch: TouchInput | undefined;
  if (options.touch && options.touch > 0) {
    touch = new TouchInput({ maxContacts: options.touch });
    dvc.register(INPUT, touch);
  }
  const clipboard = new Clipboard(
    (data) => client.sendChannel("cliprdr", data),
    onRemoteText,
  );
  client.onChannel = (name, data) => {
    if (name === "drdynvc") dvc.onStatic(data);
    else if (name === "cliprdr") clipboard.onStatic(data);
  };
  return { displayControl, clipboard, touch };
}
