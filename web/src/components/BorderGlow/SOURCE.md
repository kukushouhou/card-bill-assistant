# React Bits Border Glow

- 上游组件：https://www.reactbits.dev/components/border-glow
- 上游仓库：https://github.com/DavidHDev/react-bits
- 固定版本：`3a1c7f2f9f94ed833934ab5c2635760b9e644583`
- 原始路径：`src/ts-default/Components/BorderGlow/`
- 原始 TSX SHA-256：`6c078469e66d0a1bdbcdcc0825499ef3e61ad0ba923b1c83d0bb5c72153bf493`
- 原始 CSS SHA-256：`c6b645f1ff163046b55246a6a4f98b47d75868f4879ef445f0a83b5636acc6b4`
- 授权及版权声明：同目录 `LICENSE.md`，MIT + Commons Clause。

本地适配：新增 `externalControl` 关闭局部指针处理及悬停隐藏，让手机端通过原组件的 `--cursor-angle`、`--edge-proximity` 接入四角路径的滚动输入（左上、右上、右下、左下，再衔接下一张，回滚原路倒放）；桌面保持上游原生的卡片内指针交互，不启用该开关。新增可选 CSS 变量 `--border-glow-background` 让银行渐变在底色与边框遮罩底色中保持一致，默认仍使用上游纯色背景。原有边框网格渐变、锥形遮罩、辉光及内侧填充公式保留。页面使用 `animated={false}`，不启用开场扫光。

卡片内容、尺寸适配、手机原生滚动、减少动态效果和三层独立倾转位于相邻的 `BankCardSurface/` 中。
