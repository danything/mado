// e2e.cjs がページに入れる、本物のクライアントの部品。bun build で 1 つの JS にする(e2e.sh)
import { openTransport } from "../../web/rdp/connect";
import * as cleanpath from "../../web/rdp/rdcleanpath";
import * as x224 from "../../web/rdp/x224";

(globalThis as unknown as { e2e: unknown }).e2e = {
  openTransport,
  cleanpath,
  x224,
};
