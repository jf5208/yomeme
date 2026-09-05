# CloudBase 上线说明

下面按实际操作顺序配置。第一版不接微信支付，积分充值码由管理员生成后手动发给用户。

## 1. 准备微信小程序

1. 在微信公众平台注册小程序并取得真实 AppID。
2. 打开微信开发者工具，选择“导入项目”，目录选择本项目的 `wechat-mini-program` 文件夹。
3. 把导入界面中的测试 AppID `touristappid` 换成你自己的 AppID。
4. 导入后点击顶部“云开发”，开通一个云开发环境，并记下环境名称。

`project.private.config.json` 是本机配置，已被 Git 忽略，不需要上传 GitHub。

## 2. 创建六个数据库集合

在“云开发控制台 > 数据库”依次创建：

- `users`
- `generation_jobs`
- `generation_preparations`
- `credit_events`
- `redemption_codes`
- `share_grants`

六个集合的权限都选择“仅管理端可读写”。小程序不会直接修改积分或兑换码，所有操作都经过云函数。

## 3. 建立数据库索引

打开每个集合的“索引管理”，按顺序建立以下复合索引。字段均使用升序，只有明确写“降序”的字段使用降序。

### `generation_jobs`

- `status`、`reservationExpiresAt`、`_id`
- `_openid`、`status`、`reservationExpiresAt`、`_id`
- `status`、`createdAt`
- `originalsCleaned`、`status`、`createdAt`

### `redemption_codes`

- `createdAt` 降序、`_id` 升序

### 临时记录

- `generation_preparations`：`expiresAt`
- `share_grants`：`expiresAt`

索引创建完成后等待状态变成可用，再进行生成测试。

## 4. 设置云存储为私有

打开“云开发控制台 > 云存储 > 权限设置”，选择自定义安全规则并保存：

```json
{
  "read": "resource.openid == auth.openid || resource.openid == auth.uid",
  "write": "resource.openid == auth.openid || resource.openid == auth.uid"
}
```

这会让用户只能直接读写自己上传的文件。生成结果和好友分享由云函数签发短期地址，不公开原始宠物照片。规则保存后通常需要等待 1 到 3 分钟生效。

参考：[CloudBase 云存储安全规则](https://docs.cloudbase.net/storage/security-rules)

### 配置云存储生命周期兜底（上线必做）

为避免用户刚上传完图片就断网、关闭小程序，导致文件来不及登记清理，上线前必须配置以下两条对象生命周期规则：

1. 进入腾讯云 COS 控制台，找到这个 CloudBase 环境对应的存储桶。
2. 在“数据管理 > 生命周期”中新建规则：前缀填写 `uploads/`，当前版本文件在 7 天后删除。
3. 再建一条规则：前缀填写 `results/`，当前版本文件在 31 天后删除。

应用内的每日清理仍是主流程，生命周期只负责处理断网等极端情况下未能登记的孤立文件。`results/` 使用 31 天，是为了避免和应用内 30 天结果清理同时触发。

参考：[腾讯云 COS 生命周期配置](https://cloud.tencent.com/document/product/436/17031)

## 5. 部署主云函数

1. 在微信开发者工具中展开 `cloudfunctions`。
2. 右键 `petMemeApi`，选择“上传并部署：云端安装依赖”。
3. 在云开发控制台打开该函数，将运行环境设为 **Node.js 20.19**。
4. 将执行超时时间设为 **300 秒**；内存建议至少 512 MB。
5. 在“环境变量”添加下表三项。

| 名称 | 填写内容 |
| --- | --- |
| `ARK_API_KEY` | 火山方舟控制台创建的真实密钥 |
| `SEEDREAM_MODEL` | `doubao-seedream-4-5-251128` |
| `ADMIN_OPENIDS` | 管理员微信 OpenID；多人时用英文逗号分隔 |

密钥只填在云函数环境变量中。不要把真实密钥粘进代码、GitHub、聊天记录或截图。

查管理员 OpenID：先用管理员微信打开一次小程序，再到 `users` 集合查看这条用户记录的 `_openid`，将它填入 `ADMIN_OPENIDS`。管理员发码页没有普通入口，需要在开发者工具里直接打开 `pages/admin/index`。

参考：[CloudBase 云函数运行环境](https://docs.cloudbase.net/cloud-function/runtime-support)、[云函数配置](https://docs.cloudbase.net/cli-v1/functions/configs)

## 6. 部署每日清理函数

1. 右键 `petMemeMaintenance`，选择“上传并部署：云端安装依赖”。
2. 同样选择 **Node.js 20.19**。
3. 将执行超时时间设为 **300 秒**，内存建议至少 256 MB。
4. 在函数的“触发管理”中新建定时触发器，设置为**每天凌晨 2 点执行一次**。

再到“云函数 > 权限控制”加入函数级安全规则，禁止小程序客户端直接调用清理函数。定时触发器不受这条客户端规则影响：

```json
{
  "petMemeMaintenance": {
    "invoke": false
  },
  "*": {
    "invoke": true
  }
}
```

该函数每天先自动退款过期的生成预占任务并释放调整名额，再清理：超过 7 天的模板和宠物原图、超过 30 天的生成结果，以及过期的准备凭证和分享口令。每次最多恢复 100 个预占任务、处理 100 个生成任务，重复执行不会重复退款或扣积分。

## 7. 首次联调

按以下顺序测试，不要一上来就提交审核：

1. 新微信用户首次进入显示 300 积分。
2. 两张推荐构图正常显示。
3. 非正方形模板被立即拒绝，且不扣积分。
4. 上传 1 张模板和 1 到 3 张同一只宠物照片。
5. 勾选素材权利确认后生成，成功扣 100 积分。
6. 模拟失败，确认积分自动退回；重复点击也只扣一次。
7. 输入调整意见再生成一次，再扣 100 积分。
8. 测试保存到相册和分享；分享链接最长 7 天有效且只显示生成结果。
9. 在隐藏管理员页生成 1000 积分充值码，确认同一码只能兑换一次。
10. 用非管理员微信打开管理员页，确认看不到发码表单。
11. 确认 COS 中 `uploads/` 与 `results/` 两条生命周期规则已启用。
12. 使用真机预览，检查常见 iPhone 窄屏没有文字或按钮重叠。

确认以上项目后，再从微信开发者工具点击“上传”，到微信公众平台提交体验版或正式审核。

参考：[CloudBase 数据库索引管理](https://docs.cloudbase.net/database/data-index)
