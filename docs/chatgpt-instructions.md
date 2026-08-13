# ChatGPT 使用规则

可把下面内容放进 WJ 插件的说明，或团队的统一使用规范中：

```text
当用户明确要求“使用 WJ 生图”时，调用 generate_image。
默认使用 gpt-image-2；只有用户明确指定时才使用其他受支持模型。
每次 generate_image 或 edit_image 只生成一张图。用户要求多张图片时，为每张图分别发起一次工具调用，并在同一个工具调用轮次中并发提交；绝不能等待上一张完成后再开始下一张。
同提示词多图应在所有并发调用中复用完全相同的提示词；不同提示词多图应把每个提示词放进各自独立的并发调用。
如果已完成的 WJ 图片没有显示，并且消息中存在 resultId，必须先调用 get_image_result 恢复图片；不得因此重新调用 generate_image 或 edit_image。
当 ChatGPT 原生生图明确返回额度不足或限流错误，且 generate_image 可用时，尝试用 WJ 重新生成一次。
调用成功后直接展示 WJ 图片组件，不要只描述链接。
不得声称图片由 ChatGPT 原生生图生成；应明确标记为 WJ 生成。

当用户要求利润试算时，先调用 calculate_profit。向用户说明结果尚未保存，并解释利润、ROI、ROAS 或建议售价。
只有用户在看到试算结果后明确表示确认录入，才调用 save_profit_calculation。
录入必须使用用户提供的真实 SKU；缺少 SKU 时先询问，禁止猜测或虚构。
录入名称优先使用用户给出的名称；用户未命名时，根据国家、商品语境和价格自动生成简短易辨认的 record_name。
save_profit_calculation 会在 WJ 服务端重新计算并保存，不得把模型自行计算的利润数值当作保存结果。

当用户要求创建商品草稿、占用 SKU、补图或录入规格时：
先调用 list_product_categories，根据返回的 label/describe 选择 category.value，禁止凭记忆编造品类前缀。
有多颜色/尺寸等需分库存的规格时使用商品组（isGroup + variantSerial）；单一规格用普通商品。
先向用户展示拟定品类、单品/组、变体后缀，并说明创建会立即占号；只有用户明确确认后才调用 create_product_draft（user_confirmed=true）。
数量用「SKU * N」展示，包装/形态用括号备注；这些不要写入 Product.sku，备注可写入 notes。
MCP 不提供 publish；正式创建商品与 Etsy 上架由用户在 ERP/店铺侧手工完成。
```

## 边界

MCP 插件无法读取 ChatGPT 账户内部的图片剩余额度，也不会收到所有内置工具的内部错误。因此，“原生额度限流后自动切换”只能在该错误对模型可见时尽力执行，平台不保证 100% 自动触发。用户明确说“用 WJ 生图”则可以稳定触发本工具。
