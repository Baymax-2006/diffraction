# 圆孔衍射 · 第13章研讨题第1题 · 交互数值实验（阶段 1 + 阶段 2）

浏览器端 HTML/CSS/JavaScript 工程，入口 `index.html`。所有曲线与数值都由**复振幅数值积分**得到；
解析式只作为标注为“验算”的独立比较，从不参与生成结果。

精简提交页：[`submit.html`](submit.html)（固定 λ = 500 nm、L = 50 cm 与标准精度，只保留轴上曲线和四种二维图样；文字见 `docs/提交报告.md`）。

## 运行

| 系统 | 方法 |
|---|---|
| Windows（推荐） | 双击 `start.bat`。依次尝试 `py -3`、`python`、`node server.js`，都没有时使用 PowerShell 自带的 `serve.ps1`。浏览器自动打开 `http://127.0.0.1:8765/index.html`，关闭命令窗口即停止。 |
| macOS / Linux | `./start.sh`（python3 或 node） |
| 手动 | 在本目录执行 `python -m http.server 8765`，或 `node server.js 8765`，再打开 `http://127.0.0.1:8765/index.html` |
| 直接双击 index.html | 也能运行：`file://` 下页面把内核打包成**内联 Blob Web Worker**，计算仍在后台线程、可取消（侧栏“运行模式”显示“file:// 内联 Blob”）。浏览器连 Blob Worker 也不支持时才回退主线程并显示警告；`?engine=main` 可强制回退（测试用）。 |

不依赖网络、CDN 或 npm 包。需要 Chrome / Edge / Firefox 的较新版本。

## 文件

```
index.html        页面结构（中文界面）
styles.css        视觉系统（沿用参考工程高端款的配色、面板、按钮）
diffraction.js    物理内核（无 DOM）：单位换算、RS1 积分、求积、极值精化、r⁴ 分析、二维直接积分、共享传播核、采样规划
diffraction-q2.js 第二问内核：四情形孔径场、固定单元格随机相位、FFT 卷积、抽检、巴比涅
jobs.js           计算任务（Worker 与主线程回退共用；含 q2）
worker.js         Web Worker 入口（importScripts diffraction.js + diffraction-q2.js + jobs.js）
plot.js           Canvas 曲线控件：缩放/平移/悬停/点击标记，无物理（niceStep 也给刻度用）
lab-engine.js     任务调度与 Worker（任务 id 防止旧结果覆盖新结果）
lab-q1.js         第一问曲线、孔径示意、扫描与参数控件
lab-q2.js         第二问图样、探针与剖面
lab-export.js     配置 JSON 与 PNG/CSV 导出
app.js            启动（按上面的顺序用普通 script 加载，file:// 不必打包）
validate.js       命令行验证（require 同一个 diffraction.js），输出到 validation/
server.js / serve.ps1 / start.bat / start.sh   本地启动
tools/cdp.js, tools/browser_check.js           无头 Chrome 自动交互验证与截图（cdp.js 会禁用缓存）
tools/regression_fix1.js        修复轮浏览器回归测试（53 项：基准、问题1–7、半径扫描、1080/780 布局、file:// Blob Worker、?engine=main 回退）
tools/kernel_regression_fix1.js 修复轮内核回归测试（Node，20 项）
tools/repro_original.js         在修复前副本上复现 7 个问题（需另行准备原版副本，见报告）
tools/kernel_regression_phase2.js 第二问内核回归（27 项）
tools/regression_phase2.js        第二问浏览器回归（20 项）与截图 p2_01–11
tools/ux_regression.js            交互体验轮回归（42 项，真实鼠标/滚轮/键盘按使用者顺序 11 步 + 1080/780/390 布局），截图 screenshots/ux/修复后_*
tools/ux_repro_before.js          同一流程在修复前副本上的复现（截图 screenshots/ux/修复前_*）
validation/       验证结果：validation_report.md、results.json、extrema_standard.csv、browser_check.json、sample_exports/、
                  regression_fix1.json、kernel_regression_fix1.json、repro_before_fix.json、config_r0_roundtrip.json、
                  kernel_regression_phase2.json、regression_phase2.json、config_phase2_r0.json
screenshots/      实际浏览器截图（含第二问 p2_01–11）
PHASE1_REPORT.md  阶段 1 报告
FIX_REPORT_阶段1修复.md  修复轮报告
UX_FIX_REPORT.md  交互体验轮问题修复记录
PHASE2_REPORT.md  阶段 2 报告：方案、采样、抽检、四种情形、如何运行
```

## 物理模型与约定

* 时谐因子 `e^{-iωt}`；平面波 `e^{+ikz}`，球面子波 `e^{+ikR}/R`；“相位延迟 φ”= 复振幅乘 `e^{+iφ}`。
* 坐标：光沿 +z 从衍射屏（z = 0）到观察屏（z = L）。孔面 (X, Y)、观察屏 (X′, Y′)，原点在轴上（O、O′）。题图竖直轴标为 X(Y)、X′(Y′)，取 +X、+X′ 向上；(X, Y, z) 为右手系，迎着光看 +Y 向左。
* 积分（第一类瑞利–索末菲，略去 `(1 − 1/(ikR))`，相对影响 ≤ 1/(kL) ≈ 1.6×10⁻⁷，validate.js 实测在 r₄ 处 ΔI ≈ 3×10⁻¹³）：

  `U(P) = (1/(iλ)) ∬ U_inc(Q) (z/R) e^{ikR}/R dS`，`I = |U|²`

* 轴上 O′：`U = (A/(iλ)) ∫₀^r 2πρ (L/R) e^{ikR}/R dρ`，R = √(L²+ρ²)。环带面积权重 2πρ dρ。
  求积：[0, r] 分成宽度 ≤ h 的面板，每个面板 n 点 Gauss–Legendre，节点权重 `w_i (h/2) 2πρ_i`。
  相位用 `k(R−L) = kρ²/(R+L)` 计算，避免大数相减；输出约化场 `U′ = U e^{−ikL}`（|U′|² = |U|²）。
* 先叠加复振幅，再取模平方。孔面同相时，传播光程 R 仍给出相位差 kR。
* 归一化：A = 1，`I_inc = |A|² = 1`，纵轴 `I/I_inc`。不加遮挡的平面波用同一约定得到 `I₀ = 1`
  （validate.js 用高斯渐变孔径数值验证：w = 10 mm 时 I₀ = 0.99999937），因此 `I/I_inc = I/I₀`。
* 单位：内部一律 SI 米；nm/μm/mm/cm 只在 `Diffraction.UNITS / toSI / fromSI` 中换算。

## 采样（两套，互相独立）

* 第一问：轴上点 dR/dρ = ρ/R，面板宽 `h = λ R_max/(q r_max)`，使面板跨度的光程差 ≤ λ/q；
  预览 / 标准 / 高精：q = 10 / 20 / 40，GL 4 / 8 / 12 点（`makeQuad`，源平面积分采样）。
  标准档 h = 5.682 μm，相邻积分节点实际最大光程差 4.58 nm（λ/109）。
* **半径扫描采样**（`radiusSampling`，与上面互不影响）：边缘相位 k(R−L) 对 r 的导数 ≤ k·r_max/R_max，
  要求相邻半径采样的相位步 ≤ π/4 / π/20 / π/80（每个振荡周期 ≥ 8 / 40 / 160 点）；
  N_r = max(800 / 4000 / 16000, ⌈r_max/Δr⌉+1)，上限 6万 / 20万 / 40万。题目预设下仍为 800 / 4000 / 16000。
  例：λ = 380 nm、L = 10 cm、r_max = 6 mm 时，预览 N_r = 7567、标准 37828，均检出 473 个极大。
  预览档极值很多时改用抛物线插值定位（界面注明）；标准档、高精档始终 Brent 精化。
* 第二问规划（a = 第 4 极大半径，观察区 ±2.5 mm）：边缘 |∂R/∂X| ≤ 7.65×10⁻³ ⇒ d ≤ 6.54 μm；
  角点 |∇R| ≤ 9.72×10⁻³ ⇒ d ≤ 5.15 μm；叠加情形 3 入射相位梯度 8π/(2a) = 9499 rad/m ⇒ d ≤ 4.78 μm。
  观察面强度最高空间频率 ≈ 2a/(λL) = 10.58 mm⁻¹，Nyquist 47.3 μm，计划 ≤ 23.6 μm（213×213）。

## 极值与 r⁴

* 极值：在 I(r) 采样上找局部极大/极小，再在相邻两个采样点之间求 `dI/dr = 2Re(U*·dU/dr) = 0` 的根（Brent），
  其中 U 为数值积分，dU/dr 为被积函数在边缘的值（微积分基本定理）。第 4 个极大从这个列表中取出，不写死。
* r⁴：`C = I(r_s)/r_s⁴`（r_s = 10⁻³√(λL)，数值积分），误差 `ε(r) = |I/(C r⁴) − 1|`，
  适用区 = 从 0 起 ε 连续 ≤ 阈值的最大 r（阈值可调，默认 5%，二分精化）。

## 验证

```
node validate.js                       # 约 9 s（含第二问四情形），写 validation/validation_report.md、results.json、extrema_standard.csv
node tools/kernel_regression_fix1.js   # 约 18 s（含标准档混叠工况），写 validation/kernel_regression_fix1.json
node tools/kernel_regression_phase2.js # 约 10 s，第二问 27 项内核回归
# 以下需先启动服务器 (node server.js 8765) 与 chrome --headless --remote-debugging-port=9333
node tools/browser_check.js            # 23 项常规交互检查
node tools/regression_fix1.js          # 53 项修复轮回归（含标准档混叠工况，约 2 分钟），截图写 screenshots/01–17
node tools/regression_phase2.js        # 20 项第二问浏览器回归，截图写 screenshots/p2_01–11
node tools/ux_regression.js            # 42 项交互体验回归（约 2 分钟），截图写 screenshots/ux/修复后_*
```

## 交互

半径滑块 + 精确数值框（±1 μm）、锁定第 4 极大、恢复题目预设、精度预设、r⁴ 阈值；扩展参数（λ、L、r_max）偏离预设时显著提示。
I(r) 图：滚轮缩放（Shift 缩放纵轴）、拖动平移、双击复位、悬停读数、点击曲线跳转、点击 ▲▼ 极值跳转；横轴 r / r² / N_F；
C·r⁴ 对照、解析验算（默认关闭）、r⁴ 区阴影。双对数 r⁴ 图 + 偏差曲线；孔径/半波带示意；子波相量叠加图（M 段箭头为示意）。
状态栏显示进度、当前结果对应参数、预览/精确标记、取消/重算；过期任务结果被丢弃。
**已应用参数与编辑参数分离**：图形、指标、相量、导出只对应最近完成的结果（`result.params`）；未计算完或被取消的编辑
显示在“未应用 / 计算中”提示条中，可“应用并计算”或“放弃编辑”。所有任务都经 `endJob()` 结束（完成/过期/失败/取消）。
**极值标签**在绘图框外的上/下标签带中竖排显示名称与半径（mm，5 位小数），不裁剪、不重叠；超过 60 个极值时放大后显示。
**半径参数扫描**：从 0 自动扫描、暂停/继续、单步（ΔN_F）、上一个/下一个极值；速度以“半波带/秒”计。每帧显示的是该 r 下
稳态（时间平均）I(r)，动画只推进参数 r，光强不随时间闪烁；孔径半波带、相量和 I(r) 游标同步。
导出：提交图 PNG（主图 + 极值半径，2×）、全部图像 PNG（含元数据）、I(r) CSV、极值 CSV、参数配置 JSON（可再载入；r = 0 等合法零值保留，
非法字段用默认值并提示）。

测试钩子（仅回归测试使用）：`window.__app.debug.failNext = 'q1' | 'q1-preview' | 'point' | 'conv' | 'q2' | 'q2-preview'` 让下一条任务在 jobs.js 中模拟失败。

## 阶段 2（第二问：四种二维图样）

在“第二问”页签中，半径默认锁定为第一问求得的第 4 个轴上极大（题目预设下 r₄ = 1.3228768035 mm）。观察屏至少 5 mm × 5 mm（网格半宽略大于 ±2.5 mm，中心在 O′）。四种情形可切换：

1. **同相圆孔**：孔内入射相位为 0，传播光程仍造成干涉，屏上为菲涅耳环；轴上直接积分 I/I_inc = 3.999986。
2. **随机相位（单次实现）**，两种模型：
   - **逐点独立（题目预设）**：每个源采样点相位独立，δ = 源间距 d。换精度会换采样点，图样跟着变，没有连续极限，所以这一档**不先出粗预览**（粗网格是另一幅散斑）。可比的量是平均光强 ≈ N_cell·(δ²/λL)²，约为同相相干叠加的 1/N。切到随机相位时色标自动改成「本图各自」，并在图上注明最亮约为同相圆孔的多少分之一；对照卡仍可用共享色标。
   - **固定单元格（演示）**：相位画在边长固定的物理格子上（默认 40 μm）。像素跨格时按重叠面积对 e^{iφ} 加权。加密网格不重抽；“重新生成”才换种子。同一种子下预览 / 标准 / 高精的 O′ 都靠近 0.22770。
3. **沿 X 线性相位 8π**：孔顶相对孔底延迟 8π，φ(X) = 8π(X+r)/(2r)，乘 e^{+iφ}。图样朝 **+X′（向上，延迟端）** 平移，预计 ΔX′ = L tan(arcsin(2λ/r)) ≈ 0.377964 mm，数值峰值 0.377965 mm。两端相位模 2π 相同，并不等于同相情形（O′ 处 I ≈ 0.865，偏移点 I ≈ 3.999986）。
4. **同半径不透明圆屏（泊松亮斑）**：在复振幅上实现 U′_disk = U′_free − U′_hole，U′_free = 1，不减光强。轴上 I_disk = 0.999993 = |1−U′_hole|²。界面提供与同相圆孔的共享色标对照。

**方案**：与 `fieldAtPoint2D` 使用同一 RS1 约化核，源平面笛卡尔网格上做零填充 FFT 卷积（非远场/夫琅禾费近似）。探针与轴上点用直接极坐标积分抽检。

**实际采样（标准档，r=r₄，5×5 mm）**：8π 倾斜只计入线性相位情形。同相圆孔源间距 d ≈ 5.146 μm（只由角点光程决定），FFT N = 2048，填充因子约 1.38；线性相位仍约 4.775 μm。轴向相位步按 (k·|∇R|_边 + ∇φ)·d 报告，对角按 (√2·k·|∇R|_角 + ∇φ)·d。观察点直接取 FFT 节点（标准档 stride 4，约 245×245、d ≈ 20.58 μm，半宽 ±2.511 mm，盖住请求的 ±2.5 mm），不再把复振幅插到另一套 23.58 μm 网格上。FFT 窗口保证 N·d ≥ 2(W+a)；顶到点数上限时放宽 d。实际采样按 pathFrac × d计划/d 折算，只有粗于目标 λ/q 时才亮红色标记。比约 λ/4 还粗时直接拒绝计算，并在状态栏说明原因。非法数值（超出输入框 min/max，例如 λ = −5、L = 0、阈值 900%）会恢复原值并在状态栏写出合法范围。

预览档与精确档在状态栏和脚注中区分；计算在独立 Worker 中进行，可取消，过期结果不覆盖。半径采样若顶到点数上限，状态栏会警告极值可能混叠、第 4 极大编号可能不对。

**交互**：情形切换；锁定/解锁第 4 极大（r≠r₄ 时标明）；探针与 X′/Y′ 剖面；孔径振幅/相位预览；线性/对数色标；共享 / 本图各自 / 固定 I=4 归一（色条旁写明）；进度、取消、重算、未应用编辑提示；导出 PNG / CSV / 配置（含单位、采样、种子、情形、归一化、λ、L、r）；配置往返保留 r=0 与种子。可折叠分析：随机相位、8π 偏移方向、泊松/巴比涅。第一问页签、半径扫描、未应用编辑条和原有回归测试保持可用。

详见 `PHASE2_REPORT.md`。

### 交互体验轮（UX_FIX_REPORT.md）的行为变化

* 二维图为**等比例正方形**，带 mm 刻度；滚轮缩放（以光标为中心）、远离探针处拖动平移、双击或“复位视图”，键盘 + − 0；方向键移动探针（Shift ×10）。放大只显示已算的、落在 FFT 节点上的光强网格的插值（图上标明），不外推。
* 探针可按住拖动，剖面与读数实时跟随；停下后后台做**直接积分**（与网格插值并列显示差值）。剖面缩放在移动探针时保持，“剖面复位”回到整幅。
* 第二问请求先出约 0.5 s 的**预览档**（标明），再出所选精度；新请求**取代**旧任务（终止线程），连点情形只算最后一个。
* 色标：**共享** = 同一 λ、L、r 下已算各情形的共同上限（脚注列出）；**各自** = 本图上限（注明不可比）；**固定 4**。圆孔/圆屏对照有自己的共用色条与 O′ 标记，对数时写明亮度相差的数量级。
* 在第二问点“锁定第 4 个极大”立即按 r₄ 重算；扫描中切到第二问会自动暂停扫描；第二问失败不再写入第一问错误状态。
* 窄屏（≤860 px）压缩标题与页签、情形按钮 2×2、吸顶控制栏 ≤ 40vh，跳转时内容不被控制栏遮挡。

示例截图在 `screenshots/examples/`。验收清单在 `docs/ACCEPTANCE_CHECKLIST.md`。

