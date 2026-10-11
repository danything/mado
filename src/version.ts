// 版。package.json の version を exe に取り込む(release.yml がタグと合っているか確かめる)
import pkg from "../package.json" with { type: "json" };

export const VERSION = `v${pkg.version}`;
