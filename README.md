# 可触展品服务

本项目承载博物馆可触复刻件在公众活动中的流转协作。当前仓库只提供可运行的服务入口、领域词汇和设备事件样例，业务模块尚未建立。

`contracts/device-events.json` 记录扫码终端与传感器会交付的事件外形。事件中的 `occurred_at` 是设备认定的发生时间，`received_at` 是平台接收时间，二者不能互相替代。`event_id` 在单台设备内稳定，网络恢复后可能重复上传。

启动服务：

```bash
npm start
```

健康检查位于 `GET /health`，项目测试使用 `npm test`。
