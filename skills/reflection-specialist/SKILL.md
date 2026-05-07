# reflection-specialist

## 什么时候用

- 需要离线分析 reviewer 触发模式。
- 需要生成调参建议或偏好画像更新建议。

## 怎么用

- 读取观察样本并做离线统计。
- 输出报告到本地调试产物。
- 仅返回 advisory 结论供人工或主流程参考。

## 别做什么

- 不参与实时回合生成。
- 不自动改 prompt/policy/行为边界。
- 不做前台发言。

## 返回什么

```json
{
  "trigger_rate": 0.0,
  "patterns": ["..."],
  "suggestions": ["..."],
  "advisory_only": true
}
```
