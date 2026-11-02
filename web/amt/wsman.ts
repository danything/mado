// Intel AMT の WS-Management(SOAP 1.2)。電源の状態を読み、電源を操作する。
// 封筒は DMTF の WS-Man と、Intel の AMT SDK の CIM_PowerManagementService の形に従う。
// 返事の XML は、使う要素を名前で拾うだけにする(DOMParser の無い試験でも動かすため)。

export const NS = {
  soap: "http://www.w3.org/2003/05/soap-envelope",
  addressing: "http://schemas.xmlsoap.org/ws/2004/08/addressing",
  wsman: "http://schemas.dmtf.org/wbem/wsman/1/wsman.xsd",
  enumeration: "http://schemas.xmlsoap.org/ws/2004/09/enumeration",
};
const CIM = "http://schemas.dmtf.org/wbem/wscim/1/cim-schema/2/";
const ANONYMOUS = `${NS.addressing}/role/anonymous`;

export const RESOURCE = {
  associatedPower: `${CIM}CIM_AssociatedPowerManagementService`,
  powerService: `${CIM}CIM_PowerManagementService`,
  computerSystem: `${CIM}CIM_ComputerSystem`,
};

const ACTION = {
  enumerate: "http://schemas.xmlsoap.org/ws/2004/09/enumeration/Enumerate",
  pull: "http://schemas.xmlsoap.org/ws/2004/09/enumeration/Pull",
  powerChange: `${RESOURCE.powerService}/RequestPowerStateChange`,
};

export const escapeXml = (s: string): string =>
  s.replace(
    /[&<>"']/g,
    (c) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&apos;",
      })[c] as string,
  );

const unescapeXml = (s: string): string =>
  s.replace(
    /&(amp|lt|gt|quot|apos);/g,
    (_, e: string) =>
      ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" })[e] as string,
  );

const selectorSet = (selectors: Record<string, string>): string =>
  `<w:SelectorSet>${Object.entries(selectors)
    .map(
      ([k, v]) =>
        `<w:Selector Name="${escapeXml(k)}">${escapeXml(v)}</w:Selector>`,
    )
    .join("")}</w:SelectorSet>`;

let messageId = 0;
const nextMessageId = () =>
  typeof crypto.randomUUID === "function"
    ? `uuid:${crypto.randomUUID()}`
    : String(++messageId);

/** SOAP の封筒。宛先(a:To)は AMT の /wsman */
export function envelope(p: {
  action: string;
  resourceUri: string;
  body: string;
  selectors?: Record<string, string>;
  messageId?: string;
}): string {
  return (
    `<?xml version="1.0" encoding="utf-8"?>` +
    `<s:Envelope xmlns:s="${NS.soap}" xmlns:a="${NS.addressing}" xmlns:w="${NS.wsman}">` +
    `<s:Header>` +
    `<a:Action s:mustUnderstand="true">${p.action}</a:Action>` +
    `<a:To s:mustUnderstand="true">/wsman</a:To>` +
    `<w:ResourceURI s:mustUnderstand="true">${p.resourceUri}</w:ResourceURI>` +
    `<a:MessageID s:mustUnderstand="true">${escapeXml(p.messageId ?? nextMessageId())}</a:MessageID>` +
    `<a:ReplyTo><a:Address>${ANONYMOUS}</a:Address></a:ReplyTo>` +
    `<w:OperationTimeout>PT60S</w:OperationTimeout>` +
    (p.selectors ? selectorSet(p.selectors) : "") +
    `</s:Header>` +
    `<s:Body>${p.body}</s:Body>` +
    `</s:Envelope>`
  );
}

/** 列挙の始め。返事の EnumerationContext で Pull する */
export const enumerate = (resourceUri: string, messageId?: string): string =>
  envelope({
    action: ACTION.enumerate,
    resourceUri,
    body: `<Enumerate xmlns="${NS.enumeration}" />`,
    messageId,
  });

export const pull = (
  resourceUri: string,
  context: string,
  messageId?: string,
): string =>
  envelope({
    action: ACTION.pull,
    resourceUri,
    body:
      `<Pull xmlns="${NS.enumeration}"><EnumerationContext>${escapeXml(context)}</EnumerationContext>` +
      `<MaxElements>999</MaxElements><MaxCharacters>99999</MaxCharacters></Pull>`,
    messageId,
  });

/**
 * 電源の操作。CIM の PowerState の値で頼む。AMT が受けるのは
 * 2 電源を入れる、5 入れ直す、8 切る、10 リセット、12 OS に止めてもらう、14 OS に再起動してもらう(12 と 14 は OS 側の対応が要る)
 */
export const requestPowerStateChange = (
  powerState: number,
  messageId?: string,
): string =>
  envelope({
    action: ACTION.powerChange,
    resourceUri: RESOURCE.powerService,
    selectors: {
      CreationClassName: "CIM_PowerManagementService",
      Name: "Intel(r) AMT Power Management Service",
      SystemCreationClassName: "CIM_ComputerSystem",
      SystemName: "Intel(r) AMT",
    },
    body:
      `<r:RequestPowerStateChange_INPUT xmlns:r="${RESOURCE.powerService}">` +
      `<r:PowerState>${Math.trunc(powerState)}</r:PowerState>` +
      `<r:ManagedElement>` +
      `<Address xmlns="${NS.addressing}">${ANONYMOUS}</Address>` +
      `<ReferenceParameters xmlns="${NS.addressing}">` +
      `<ResourceURI xmlns="${NS.wsman}">${RESOURCE.computerSystem}</ResourceURI>` +
      `<SelectorSet xmlns="${NS.wsman}">` +
      `<Selector Name="CreationClassName">CIM_ComputerSystem</Selector>` +
      `<Selector Name="Name">ManagedSystem</Selector>` +
      `</SelectorSet>` +
      `</ReferenceParameters>` +
      `</r:ManagedElement>` +
      `</r:RequestPowerStateChange_INPUT>`,
    messageId,
  });

/** 名前空間の接頭辞を問わず、その名前の要素の中身をすべて拾う */
export function elements(xml: string, name: string): string[] {
  const re = new RegExp(
    `<(?:[\\w.-]+:)?${name}(?:\\s[^>]*)?>([^<]*)</(?:[\\w.-]+:)?${name}>`,
    "g",
  );
  return [...xml.matchAll(re)].map((m) => unescapeXml((m[1] as string).trim()));
}

export const element = (xml: string, name: string): string | undefined =>
  elements(xml, name)[0];

/** SOAP の Fault なら、その理由(Text か Subcode の Value) */
export function fault(xml: string): string | undefined {
  if (!/<(?:[\w.-]+:)?Fault[\s>]/.test(xml)) return undefined;
  return element(xml, "Text") ?? elements(xml, "Value").at(-1) ?? "SOAP Fault";
}

/** CIM_AssociatedPowerManagementService の今の電源の状態と、頼める状態の並び */
export type PowerInfo = { state?: number; available: number[] };

export function parsePower(xml: string): PowerInfo {
  const n = (s: string | undefined) =>
    s === undefined || s === "" ? undefined : Number(s);
  return {
    state: n(element(xml, "PowerState")),
    available: elements(xml, "AvailableRequestedPowerStates")
      .map(Number)
      .filter((v) => Number.isInteger(v)),
  };
}

/** CIM の PowerState(今の状態)の名前 */
export function powerStateName(state: number | undefined): string {
  switch (state) {
    case 2:
      return "オン(S0)";
    case 3:
      return "スリープ(S1)";
    case 4:
      return "スリープ(S3)";
    case 6:
      return "オフ(電源なし)";
    case 7:
      return "休止状態(S4)";
    case 8:
      return "オフ(S5)";
    case 9:
      return "入れ直し中";
    case 13:
      return "オフ";
    case undefined:
      return "不明";
    default:
      return `状態 ${state}`;
  }
}

/** 電源が入っているか(オンかスリープ) */
export const isOn = (state: number | undefined): boolean =>
  state === 2 || state === 3 || state === 4;

/** RequestPowerStateChange の ReturnValue の意味 */
export function returnValueText(v: number | undefined): string {
  switch (v) {
    case 0:
      return "受け付けました";
    case 1:
      return "対応していない操作です(1)";
    case 2:
      return "失敗しました(2)";
    case 3:
      return "時間切れです(3)";
    case 4:
      return "失敗しました(4)";
    case 5:
      return "指定が正しくありません(5)";
    case 4096:
      return "受け付けました(処理中)";
    case undefined:
      return "返事に ReturnValue がありません";
    default:
      return `ReturnValue ${v}`;
  }
}
