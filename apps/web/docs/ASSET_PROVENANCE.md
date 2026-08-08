# 资产来源记录

本文件记录 `apps/web/public/` 中需要单独核对来源和许可的静态资产。源文件出现在内部或旧版
工程中，不等于已经取得复制、修改或公开分发许可。

## 当前状态

根据仓库维护者在 2026-07-24 的明确恢复要求，公开 Web workspace 当前包含站点 Logo、
六张系列标志和六张顶部系列墙图片。除下文逐项记录的文件外，不从私有 Legacy
工程迁入其他图片、字体或音视频。

## 站点 Logo

`public/brand/imsweb-logo.png` 从现代 Web 初始提交 `aadff77` 原样恢复；该文件与 Legacy
`public/assets/images/logo.png` 完全一致，尺寸为 545 x 188，SHA-256 为
`aa2ed68b5c1df4e8800a576dd09251c314b0da8f37b43e96247b64e993aeb483`。
浏览器默认使用的 `public/brand/imsweb-logo.webp` 由该 PNG 通过 Sharp 无损转换生成；PNG
继续作为可追溯源文件保留。

## 系列标志

根据仓库维护者在 2026-07-24 的明确恢复要求，以下六张系列标志从本地 Legacy 历史快照
`imsweb-legacy-history-019f92ba` 原样恢复，用于公共页面背景漂浮动效及全站浏览器图标轮换：

| Web 路径                                   | Legacy 来源路径                                       | SHA-256                                                            |
| ------------------------------------------ | ----------------------------------------------------- | ------------------------------------------------------------------ |
| `public/brand/series/765pro.png`           | `public/assets/images/Production/765PRO.png`          | `29733a8da4902052ea703863a3462c331d19a7299df7994753dbaaa6d46d4f0c` |
| `public/brand/series/cinderella-girls.png` | `public/assets/images/Production/CinderellaGirls.png` | `1f4ac098baf2fcf62b6d02d8bfc148dd0b455d174d23c2cdd0aee85c5fe5885f` |
| `public/brand/series/million-live.png`     | `public/assets/images/Production/Million.png`         | `179fe5d36440eb15d314781d463c6872b5518578ef6e8d8ea5b1a57cc007dcb5` |
| `public/brand/series/sidem.png`            | `public/assets/images/Production/SideM.png`           | `2a13de61aa1dab8f7226a7d0b8367c4d71587c94e81142cd12b28b15ccd41dde` |
| `public/brand/series/shiny-colors.png`     | `public/assets/images/Production/Shinycolors.png`     | `d43d0342b40a2796c5601282ce6b619e536644bec85f59e3dbb548d8b2179370` |
| `public/brand/series/gakuen.png`           | `public/assets/images/Production/Gakuen.png`          | `81e95e2b5199f44343762f16872fa76aadb047753958e85f68479ba1fb06e01c` |

文件未裁切、重绘或转换格式。相关标志及商标权归各自权利人，不因仓库代码采用 MIT 而
自动获得 MIT 许可；公开部署和再分发范围仍应由仓库维护者按实际授权确认。

## 首页顶部系列墙

以下六张人物图片从同一 Legacy 历史快照原样恢复，用于首页顶部系列墙：

| Web 路径                                        | Legacy 来源路径                                       | SHA-256                                                            |
| ----------------------------------------------- | ----------------------------------------------------- | ------------------------------------------------------------------ |
| `public/brand/series/wall/765pro.png`           | `public/assets/images/Production/765intro.png`        | `63da4813056133985026a0bdca7306fac3ec3a1623a954a573c55077a7976ef3` |
| `public/brand/series/wall/cinderella-girls.png` | `public/assets/images/Production/Cinderellaintro.png` | `a82350e4e94c043525769a003b4a15609cdb4db742701335d13d3f727bb807c8` |
| `public/brand/series/wall/million-live.png`     | `public/assets/images/Production/Millionintro.png`    | `a271dcd8a33ce71e21f4c957a813042c9c5f54dd33f73d73d888be4f5ab66272` |
| `public/brand/series/wall/sidem.png`            | `public/assets/images/Production/Sidemintro.png`      | `bded4f68a603c8f1d060b5cf2b35ef3f95fff4939df972d9f0cf1e688598cbec` |
| `public/brand/series/wall/shiny-colors.png`     | `public/assets/images/Production/Shinyintro.png`      | `19c28aba0714205de23238a59012288b503d388d0b4922d430919070247f4bb3` |
| `public/brand/series/wall/gakuen.png`           | `public/assets/images/Production/Gakuenintro.png`     | `0205ebb95118b234635b57d5d2a7b2043f5cecf52cb8720fe80976d12816d09d` |

六张文件均为 585 x 500 PNG，未裁切、重绘或转换格式。人物图像的著作权和相关标志权利
归各自权利人，许可边界与上节相同。

同目录的六张 `.webp` 由对应 PNG 通过 Sharp 以 quality 85、alpha quality 100 和 smart
subsample 参数生成，作为浏览器默认交付版本；原始 PNG 继续用于来源核验和后续再编码。

`public/favicon.ico` 随 Web 工程初始化进入仓库。若未来替换为定制图标，应在同一变更中记录
作者、原始来源、适用许可证或书面授权、允许的使用范围、修改情况和 SHA-256。

## Wiki 视图切换图标

`public/brand/wiki-view-switch.png` 由仓库维护者在 2026-08-02 的本次需求中直接上传，并明确
要求用于新版与经典 Wiki 之间的视图切换。文件以原始 PNG 字节提交，未裁切、重绘或转换；尺寸
为 167 x 167，SHA-256 为
`9cda55e6d140050e2bc8a637cda6fa6e6d12596611e1d58bb706cd96c1cac076`。本次书面授权范围限于
IMSWeb 公开 Web 的 Wiki 视图切换入口，不自动扩展到其他用途或再许可。

## 地图数据与样式

`public/maps/exchange-style.json` 是 2026-08-03 从 OpenFreeMap 官方 Bright style 地址
`https://tiles.openfreemap.org/styles/bright` 获取的原始响应稳定副本，未修改 JSON 字节；
获取时官方响应的 `Last-Modified` 为 2026-08-02 22:00:41 GMT。当前 SHA-256 为
`ada317e9b31c65b726dc46a2b3b14acb9856782051a09e3f4bc92d034373999f`。OpenFreeMap
styles 仓库整体采用 MIT 许可证；其随附许可清单同时注明 Bright 上游代码采用 BSD-3-Clause、
设计采用 CC BY 4.0，字体、图标与 Natural Earth 数据分别保留各自许可。IMSWeb 仅保存 style
JSON；冷灰、浅蓝配色在运行时通过 MapLibre paint property 覆盖，不修改此稳定副本。

该 style 会在浏览器运行时向 `https://tiles.openfreemap.org` 请求 OpenFreeMap planet
TileJSON 与矢量瓦片、Natural Earth raster、sprite 和 Noto Sans glyph。地图请求白名单只允许
当前站点 origin 与该主机的 HTTPS 默认端口，不允许其他第三方主机、HTTP 或非默认端口。
OpenFreeMap planet TileJSON 提供常驻署名：OpenFreeMap、OpenMapTiles，以及
`Data from OpenStreetMap`；Web 端使用非 compact 的 MapLibre attribution control 在地图左下角
显示该署名。OpenStreetMap 数据的版权和许可说明以
`https://www.openstreetmap.org/copyright` 为准，使用与再分发时不得移除署名。

`public/maps/china-provinces.json` 于 2026-07-26 从阿里云 DataV GeoAtlas 的公开接口
`https://geo.datav.aliyun.com/areas_v3/bound/100000_full.json` 获取，并在提交 `ed34551`
中由仓库维护者加入公开 Producer Map；当前交换地图仅复用该既有文件，未再次下载或修改。
历史处理移除了 `100000_JD` 插图以及海南远端南海岛屿多边形，当前 SHA-256 为
`e5dfb9afc4ab94ea5ea09208397c4c000646db0c8bb2706207ca49bbc63b9017`。阿里云官方文档允许从
DataV GeoAtlas 导出或下载行政区 GeoJSON 用于地图配置，但未为该数据单独声明 MIT
再分发许可；因此该文件不标记为 MIT，其公开部署与再分发继续受阿里云条款及仓库维护者既有
授权范围约束。交换地图切换到上述 OpenFreeMap 全球底图后已不再引用此文件；Producer Map
仍可能继续使用它。

## 新增资产要求

新增静态资产必须满足以下条件：

- 权利人和原始来源可验证；
- 许可证或书面授权明确允许仓库公开分发及预期使用；
- 修改、裁切或格式转换已记录；
- 文件 SHA-256 与提交内容一致；
- 商标或人物素材不会因代码采用 MIT 而被错误标记为 MIT。

无法满足以上条件的文件不得进入公开仓库或发布产物。
