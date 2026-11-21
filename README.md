# 影展换厅后的放映介质接收与开场确认

资料联调站以本地合成资料模拟分别维护的业务来源。用 Node.js 22.23.4 启动，支持在同一进程中切换来源发布。启动后地址默认是 `http://127.0.0.1:4178`，可用环境变量 `PORT` 修改。

浏览器联调使用 Playwright 1.56.1。首次在新环境准备依赖时执行 `npm ci` 和 `npx playwright install chromium`。已有对应 Chromium 的环境可以直接运行。

```sh
npm run origin
npm test
```

`npm run origin` 为独立的来源服务。`npm test` 另起临时端口验证资料站，不需要预先启动来源进程。测试包含 Chromium 中的页面操作。

联调站的 `GET /_desk/releases` 返回发布名与当前档。值台可向 `/_desk/releases/发布名` 发送 POST 切换资料，发布名按 UTF-8 进行 URL 编码。可选档位为首发、换厅、新授权。切换后各来源从当前档的内容响应，业务数据以原接口的版本字段与时间为准。联调档位名称仅用于控制资料站。

## 来源协议

排期来自 `/schedule/roster`。每个 `show` 只列当前 `rev`，本地放映时间以 `zone` 解释，结束时间小于开始时间表示跨午夜。 `use` 区分正式场和试播。
授权交付从 `/portal/shows` 操作。页面有场次和用途选择，确认后显示组合号、清单版本、介质下载链接、摘要及设备授权的 UTC 区间。链接可能随发行窗口关闭，误用会返回 410。演练介质是短文本载荷。 `/terminals/imports` 按场次给终端实际导入回执，`/terminals/inventory` 反映是否可用。
`requests.json` 为值台接收的排片范围。页面上的设备证号均为虚构，资料没有真实影片或放映授权。

`sources/exchange.json` 保存联调站的来源记录和原件载荷，`sources/requests.json` 保存业务席可用的请求材料。材料中的单位、标识、组织及记录内容均为合成。
