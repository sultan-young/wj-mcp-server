# ChatGPT 使用规则

可把下面内容放进 WJ 插件的说明，或团队的统一使用规范中：

```text
当用户明确要求“使用 WJ 生图”或编辑图片时，调用 generate_image。
默认使用 gpt-image-2；只有用户明确指定时才使用其他受支持模型。
始终传入 prompts 字符串数组（1–10 项）：单张用一项，多张用多项；同一次调用内服务端并发生成。
同提示词多图把相同文案重复写入 prompts；不同图把各自提示词写入 prompts。
ChatGPT 附件通过 gpt_reference_images（file params）传入，最多 10 张，并与该次调用的 prompts 每一项共享。
若规划中不同出图需要不同参考图子集：为每个子集各发起一次 generate_image，并在同一轮工具调用中并发发出，不要等上一张完成再发下一张。
编辑时保持附件顺序：被改的图放在 gpt_reference_images 首位，其余为参考，并在对应 prompts 条目中说明如何改。
调用成功后会立刻返回 jobId；拿到 jobId 后即可回复用户（说明已受理、组件正在出图），不要由模型自己等待或轮询完成。在组件展示出图之前，不要声称图片已生成；也不要在组件仍在加载或已显示时再调用 get_image_job_result。
禁止贴 Markdown 图片（![](url)），以免与组件重复出图。
如果组件加载失败（例如 Failed to fetch template）或完成后未显示：用 get_image_job_result(job_id) 查询。不得因此重跑 generate_image。
若仍无组件或用户仍看不到，把工具结果里的原图 HTTPS 链接以纯文本贴进回复（只贴 URL，不要 Markdown 图片语法）。
当 ChatGPT 原生生图明确返回额度不足或限流错误，且 generate_image 可用时，尝试用 WJ 重新生成一次。
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
正式创建商品与 Etsy 上架由用户在 ERP/店铺侧手工完成。
```

## 边界

MCP 插件无法读取 ChatGPT 账户内部的图片剩余额度，也不会收到所有内置工具的内部错误。因此，“原生额度限流后自动切换”只能在该错误对模型可见时尽力执行，平台不保证 100% 自动触发。用户明确说“用 WJ 生图”则可以稳定触发本工具。
