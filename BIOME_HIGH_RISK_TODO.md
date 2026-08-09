# BIOME High-Risk Lint TODO（剩余 106 条，agent 记录，后续专项修复）

> 来源: `biome check src/`（2026-08-09；`lint` script = `biome check src/`）
> 全部为高风险/需语义判断类，本批次未改（按用户指令记录专属文件）
> 修复建议：`noExplicitAny`→具体类型/unknown 窄化/注释；`noNonNullAssertion`→空值守卫或可选链；`noImportantStyles`→提升特异性，确需覆盖时保留并注释。

## src\components\chat\MentionComposer.tsx（3 条）
- L1221 [noNonNullAssertion]: Forbidden non-null assertion.
- L1957 [noNonNullAssertion]: Forbidden non-null assertion.
- L2085 [noNonNullAssertion]: Forbidden non-null assertion.

## src\components\git\GitBranchSelector.tsx（9 条）
- L824 [noNonNullAssertion]: Forbidden non-null assertion.
- L832 [noNonNullAssertion]: Forbidden non-null assertion.
- L918 [noNonNullAssertion]: Forbidden non-null assertion.
- L924 [noNonNullAssertion]: Forbidden non-null assertion.
- L1153 [noNonNullAssertion]: Forbidden non-null assertion.
- L1168 [noNonNullAssertion]: Forbidden non-null assertion.
- L1189 [noNonNullAssertion]: Forbidden non-null assertion.
- L1436 [noNonNullAssertion]: Forbidden non-null assertion.
- L1444 [noNonNullAssertion]: Forbidden non-null assertion.

## src\components\project-tools\git-review\HistoryView.tsx（3 条）
- L882 [noNonNullAssertion]: Forbidden non-null assertion.
- L1269 [noNonNullAssertion]: Forbidden non-null assertion.
- L1279 [noNonNullAssertion]: Forbidden non-null assertion.

## src\components\project-tools\git-review\StatusView.tsx（8 条）
- L301 [noNonNullAssertion]: Forbidden non-null assertion.
- L309 [noNonNullAssertion]: Forbidden non-null assertion.
- L326 [noNonNullAssertion]: Forbidden non-null assertion.
- L333 [noNonNullAssertion]: Forbidden non-null assertion.
- L338 [noNonNullAssertion]: Forbidden non-null assertion.
- L354 [noNonNullAssertion]: Forbidden non-null assertion.
- L359 [noNonNullAssertion]: Forbidden non-null assertion.
- L621 [noNonNullAssertion]: Forbidden non-null assertion.

## src\components\project-tools\git-review\Toolbar.tsx（1 条）
- L899 [noNonNullAssertion]: Forbidden non-null assertion.

## src\index.css（12 条）
- L532 [noImportantStyles]: Avoid the use of the !important style.
- L1386 [noImportantStyles]: Avoid the use of the !important style.
- L1387 [noImportantStyles]: Avoid the use of the !important style.
- L1391 [noImportantStyles]: Avoid the use of the !important style.
- L1392 [noImportantStyles]: Avoid the use of the !important style.
- L1654 [noImportantStyles]: Avoid the use of the !important style.
- L1663 [noImportantStyles]: Avoid the use of the !important style.
- L1799 [noImportantStyles]: Avoid the use of the !important style.
- L2339 [noImportantStyles]: Avoid the use of the !important style.
- L2392 [noImportantStyles]: Avoid the use of the !important style.
- L2420 [noImportantStyles]: Avoid the use of the !important style.
- L2434 [noImportantStyles]: Avoid the use of the !important style.

## src\lib\chat\conversation\chatAbort.ts（3 条）
- L65 [noExplicitAny]: Unexpected any. Specify a different type.
- L131 [noExplicitAny]: Unexpected any. Specify a different type.
- L252 [noExplicitAny]: Unexpected any. Specify a different type.

## src\lib\chat\messages\userMessageContent.tsx（2 条）
- L489 [noNonNullAssertion]: Forbidden non-null assertion.
- L650 [noNonNullAssertion]: Forbidden non-null assertion.

## src\lib\providers\hostedSearchEvents.ts（1 条）
- L190 [noNonNullAssertion]: Forbidden non-null assertion.

## src\lib\providers\nativeResponsesAttachments.ts（21 条）
- L9 [noExplicitAny]: Unexpected any. Specify a different type.
- L153 [noExplicitAny]: Unexpected any. Specify a different type.
- L157 [noExplicitAny]: Unexpected any. Specify a different type.
- L161 [noExplicitAny]: Unexpected any. Specify a different type.
- L165 [noExplicitAny]: Unexpected any. Specify a different type.
- L169 [noExplicitAny]: Unexpected any. Specify a different type.
- L176 [noExplicitAny]: Unexpected any. Specify a different type.
- L231 [noExplicitAny]: Unexpected any. Specify a different type.
- L261 [noExplicitAny]: Unexpected any. Specify a different type.
- L416 [noExplicitAny]: Unexpected any. Specify a different type.
- L440 [noExplicitAny]: Unexpected any. Specify a different type.
- L534 [noExplicitAny]: Unexpected any. Specify a different type.
- L571 [noExplicitAny]: Unexpected any. Specify a different type.
- L627 [noExplicitAny]: Unexpected any. Specify a different type.
- L679 [noExplicitAny]: Unexpected any. Specify a different type.
- L737 [noExplicitAny]: Unexpected any. Specify a different type.
- L788 [noExplicitAny]: Unexpected any. Specify a different type.
- L853 [noExplicitAny]: Unexpected any. Specify a different type.
- L894 [noExplicitAny]: Unexpected any. Specify a different type.
- L935 [noExplicitAny]: Unexpected any. Specify a different type.
- L976 [noExplicitAny]: Unexpected any. Specify a different type.

## src\lib\providers\nativeWebSearch.ts（2 条）
- L45 [noExplicitAny]: Unexpected any. Specify a different type.
- L50 [noExplicitAny]: Unexpected any. Specify a different type.

## src\lib\providers\runtime\geminiToolPayload.ts（1 条）
- L236 [noExplicitAny]: Unexpected any. Specify a different type.

## src\lib\providers\runtime\modelFactory.ts（10 条）
- L33 [noExplicitAny]: Unexpected any. Specify a different type.
- L34 [noExplicitAny]: Unexpected any. Specify a different type.
- L34 [noExplicitAny]: Unexpected any. Specify a different type.
- L34 [noExplicitAny]: Unexpected any. Specify a different type.
- L35 [noExplicitAny]: Unexpected any. Specify a different type.
- L51 [noExplicitAny]: Unexpected any. Specify a different type.
- L60 [noExplicitAny]: Unexpected any. Specify a different type.
- L152 [noExplicitAny]: Unexpected any. Specify a different type.
- L296 [noExplicitAny]: Unexpected any. Specify a different type.
- L355 [noExplicitAny]: Unexpected any. Specify a different type.

## src\lib\providers\runtime\nativeSearchPayload.ts（2 条）
- L99 [noExplicitAny]: Unexpected any. Specify a different type.
- L123 [noExplicitAny]: Unexpected any. Specify a different type.

## src\lib\providers\runtime\payloadPipeline.ts（1 条）
- L30 [noExplicitAny]: Unexpected any. Specify a different type.

## src\lib\providers\runtime\streamByApi.ts（7 条）
- L36 [noExplicitAny]: Unexpected any. Specify a different type.
- L72 [noExplicitAny]: Unexpected any. Specify a different type.
- L87 [noExplicitAny]: Unexpected any. Specify a different type.
- L113 [noExplicitAny]: Unexpected any. Specify a different type.
- L166 [noExplicitAny]: Unexpected any. Specify a different type.
- L182 [noExplicitAny]: Unexpected any. Specify a different type.
- L200 [noExplicitAny]: Unexpected any. Specify a different type.

## src\lib\providers\runtime\textOnlyRuntime.ts（1 条）
- L64 [noExplicitAny]: Unexpected any. Specify a different type.

## src\lib\providers\runtime\thinkingLevels.ts（6 条）
- L25 [noExplicitAny]: Unexpected any. Specify a different type.
- L31 [noExplicitAny]: Unexpected any. Specify a different type.
- L46 [noExplicitAny]: Unexpected any. Specify a different type.
- L69 [noExplicitAny]: Unexpected any. Specify a different type.
- L109 [noExplicitAny]: Unexpected any. Specify a different type.
- L185 [noExplicitAny]: Unexpected any. Specify a different type.

## src\lib\settings\storage.ts（9 条）
- L243 [noExplicitAny]: Unexpected any. Specify a different type.
- L257 [noExplicitAny]: Unexpected any. Specify a different type.
- L265 [noExplicitAny]: Unexpected any. Specify a different type.
- L273 [noExplicitAny]: Unexpected any. Specify a different type.
- L281 [noExplicitAny]: Unexpected any. Specify a different type.
- L295 [noExplicitAny]: Unexpected any. Specify a different type.
- L310 [noExplicitAny]: Unexpected any. Specify a different type.
- L318 [noExplicitAny]: Unexpected any. Specify a different type.
- L349 [noExplicitAny]: Unexpected any. Specify a different type.

## src\lib\skills\index.ts（3 条）
- L408 [noExplicitAny]: Unexpected any. Specify a different type.
- L542 [noExplicitAny]: Unexpected any. Specify a different type.
- L550 [noExplicitAny]: Unexpected any. Specify a different type.

## src\lib\subagents\store.ts（1 条）
- L297 [noNonNullAssertion]: Forbidden non-null assertion.
