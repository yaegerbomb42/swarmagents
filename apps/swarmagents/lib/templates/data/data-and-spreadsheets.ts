import type { TaskTemplate } from "../types";

/** Category: data and spreadsheets. */
export const DATA_AND_SPREADSHEETS: TaskTemplate[] = [
  {
    id: "clean-a-csv",
    category: "data-and-spreadsheets",
    title: "Clean a messy CSV",
    pitch: "Duplicate rows gone, columns normalised, and a report of what changed.",
    prompt:
      "Clean the CSV at {{csv_path}} and write the result to {{output_path}}.\n\n" +
      "The data has: {{problems}}\n\n" +
      "Rules:\n" +
      "- Do not lose rows silently. Every row you drop or merge must be listed in the report with the reason and its original line number.\n" +
      "- Normalise headers to {{header_style}}.\n" +
      "- Normalise the {{date_column}} column to {{date_format}} and the {{numeric_column}} column to a number, stripping {{currency}} symbols and thousands separators.\n" +
      "- Keep the original file untouched.\n" +
      "- Print a summary: rows in, rows out, what you changed and how many of each.\n\n" +
      "Use {{tool}} and show me the summary and the first {{preview_rows}} rows of the cleaned file.",
    fields: [
      { name: "csv_path", label: "CSV to clean", type: "text", default: "/workspace/uploads/sales.csv" },
      { name: "output_path", label: "Cleaned file to write", type: "text", default: "/workspace/sales-clean.csv" },
      { name: "problems", label: "What's wrong with it", type: "textarea", default: "duplicate order ids, dates in three formats, prices with currency symbols, a blank column, some rows with commas inside quotes" },
      { name: "header_style", label: "Header style", type: "select", options: ["snake_case", "camelCase", "Title Case"], default: "snake_case" },
      { name: "date_column", label: "Date column", type: "text", default: "order_date" },
      { name: "date_format", label: "Target date format", type: "select", options: ["ISO 8601 (YYYY-MM-DD)", "DD/MM/YYYY", "MM/DD/YYYY"], default: "ISO 8601 (YYYY-MM-DD)" },
      { name: "numeric_column", label: "Numeric column", type: "text", default: "amount" },
      { name: "currency", label: "Currency to strip", type: "text", default: "$" },
      { name: "tool", label: "Tool to use", type: "select", options: ["Python (pandas)", "Python (csv module)", "Node (csv-parse)"], default: "Python (pandas)" },
      { name: "preview_rows", label: "Rows to preview", type: "text", default: "10" },
    ],
    role: "data-analyst",
    estimatedMinutes: 15,
    tools: ["read_file", "bash", "write_file"],
    mcp: [],
    example:
      "sales-clean.csv written (2,418 rows in, 2,401 out).\n" +
      "  14 duplicate order_ids merged (kept the row with the later order_date; listed in dropped-rows.md)\n" +
      "  3 rows dropped: no order_id and no customer (dropped-rows.md lines 88, 902, 1733)\n" +
      "  order_date normalised to ISO 8601 (was 3 formats), amount stripped of '$' and ','\n" +
      "  the blank 'notes' column was dropped (empty in every row)\n" +
      "First 10 rows:\n  order_id,order_date,customer,amount\n  1001,2026-01-04,Ada Lovelace,249.00",
  },
  {
    id: "monthly-report-from-csv",
    category: "data-and-spreadsheets",
    title: "Turn a CSV into a monthly report",
    pitch: "Grouped totals, the month-over-month change and a chart-ready summary.",
    prompt:
      "Build a monthly report from {{csv_path}} and write it to {{output_path}}.\n\n" +
      "The report needs:\n" +
      "- Revenue, orders and average order value per month, for {{months}} months.\n" +
      "- Month-over-month change for each metric, as a percentage, with the previous month as the base.\n" +
      "- The top {{top_n}} customers by revenue, and the top {{top_n}} products by units sold.\n" +
      "- One table and one short paragraph of plain-English commentary per month — what moved and what probably drove it, based only on the data.\n\n" +
      "State the exact column you used for each figure. If a month has no rows, say 'no data' rather than treating it as zero. Use {{tool}}.",
    fields: [
      { name: "csv_path", label: "CSV to report on", type: "text", default: "/workspace/uploads/orders.csv" },
      { name: "output_path", label: "Where to write the report", type: "text", default: "/workspace/reports/monthly.md" },
      { name: "months", label: "How many months", type: "text", default: "6" },
      { name: "top_n", label: "How many top customers and products", type: "text", default: "5" },
      { name: "tool", label: "Tool to use", type: "select", options: ["Python (pandas)", "Python (csv module)", "SQL over a SQLite import"], default: "Python (pandas)" },
    ],
    role: "data-analyst",
    estimatedMinutes: 20,
    tools: ["read_file", "bash", "write_file"],
    mcp: [],
    example:
      "# Monthly report — orders.csv\n\n" +
      "| Month | Revenue | Orders | AOV | MoM revenue |\n|---|---|---|---|---|\n" +
      "| 2026-05 | 48,120.00 | 512 | 93.98 | +12.4% |\n| 2026-06 | 61,905.50 | 604 | 102.49 | +28.7% |\n\n" +
      "Revenue is sum(amount); orders is count(order_id); AOV is revenue / orders.\n" +
      "June grew 28.7% on the back of the new Starter plan; 142 of the 92 new customers came from the June newsletter.\n" +
      "Top customers: Ada Lovelace 4,320.00; Grace Hopper 3,910.50; Alan Turing 3,244.00.",
  },
  {
    id: "merge-two-sheets",
    category: "data-and-spreadsheets",
    title: "Join two spreadsheets",
    pitch: "Rows matched on the right key, unmatched rows listed, and no silent drops.",
    prompt:
      "Join {{left_csv}} and {{right_csv}} on {{join_key}} and write the merged file to {{output_path}}.\n\n" +
      "Rules:\n" +
      "- Use a {{join_type}} join.\n" +
      "- List every row from the left file that had no match, with its key, in a separate file {{unmatched_path}}.\n" +
      "- If a key appears more than once on the right, do not silently pick one: report the duplicate keys and say which row you used and why.\n" +
      "- Keep the left file's column order and append the right file's columns, prefixing them with the right file's name.\n" +
      "- Report the counts: left rows, right rows, matched, unmatched left, unmatched right.\n\n" +
      "Use {{tool}}.",
    fields: [
      { name: "left_csv", label: "Left file", type: "text", default: "/workspace/uploads/customers.csv" },
      { name: "right_csv", label: "Right file", type: "text", default: "/workspace/uploads/orders.csv" },
      { name: "join_key", label: "Join key", type: "text", default: "customer_id" },
      { name: "join_type", label: "Join type", type: "select", options: ["left", "inner", "outer"], default: "left" },
      { name: "output_path", label: "Merged file", type: "text", default: "/workspace/merged.csv" },
      { name: "unmatched_path", label: "Unmatched rows file", type: "text", default: "/workspace/unmatched.csv" },
      { name: "tool", label: "Tool to use", type: "select", options: ["Python (pandas)", "Python (csv module)", "SQL over SQLite"], default: "Python (pandas)" },
    ],
    role: "data-analyst",
    estimatedMinutes: 15,
    tools: ["read_file", "bash", "write_file"],
    mcp: [],
    example:
      "merged.csv — left 1,204 rows, right 8,912 rows.\n" +
      "  matched on customer_id: 1,190\n" +
      "  left rows with no match: 14 -> unmatched.csv\n" +
      "  right rows with no match: 3 (customers that never ordered)\n" +
      "  duplicate customer_id on the right: 2 keys (cust_88, cust_104) — summed their order totals and said so in the report\n" +
      "  columns: the 6 customer columns, then orders_* for the 5 order columns.",
  },
  {
    id: "forecast-a-metric",
    category: "data-and-spreadsheets",
    title: "Forecast a metric from history",
    pitch: "A forecast with its method, its error bar and an honest note on what it cannot see.",
    prompt:
      "Forecast {{metric}} for the next {{horizon}} days using the history in {{csv_path}}, and write the forecast to {{output_path}}.\n\n" +
      "Requirements:\n" +
      "- Fit a simple, explainable model — {{model}} — and say in one sentence why it fits this series.\n" +
      "- Report the backtest error: how the model would have done over the last {{backtest_days}} days, with the mean absolute error.\n" +
      "- Give the forecast as a point per day plus an {{interval}} band.\n" +
      "- List the assumptions the forecast depends on and what would break it.\n" +
      "- If the series is too short or too noisy to forecast, say so instead of producing a confident number.\n\n" +
      "Use {{tool}} and show the forecast table.",
    fields: [
      { name: "metric", label: "Metric to forecast", type: "text", default: "daily active users" },
      { name: "csv_path", label: "History file", type: "text", default: "/workspace/uploads/metrics.csv" },
      { name: "output_path", label: "Where to write the forecast", type: "text", default: "/workspace/reports/forecast.md" },
      { name: "horizon", label: "Forecast horizon (days)", type: "text", default: "14" },
      { name: "model", label: "Model", type: "select", options: ["linear trend", "moving average", "exponential smoothing", "same day-of-week average"], default: "exponential smoothing" },
      { name: "backtest_days", label: "Backtest window (days)", type: "text", default: "28" },
      { name: "interval", label: "Interval band", type: "select", options: ["80%", "95%"], default: "95%" },
      { name: "tool", label: "Tool to use", type: "select", options: ["Python (pandas)", "Python (numpy)", "Python (statsmodels)"], default: "Python (statsmodels)" },
    ],
    role: "data-analyst",
    estimatedMinutes: 25,
    tools: ["read_file", "bash", "write_file"],
    mcp: [],
    example:
      "# DAU forecast — next 14 days\n\n" +
      "Model: exponential smoothing (level + trend). The series has a mild upward trend and a weekly cycle; a plain trend fit under-predicted Mondays by 18%.\n" +
      "Backtest over the last 28 days: MAE 412 users (3.9% of the mean).\n" +
      "| Day | Forecast | 95% band |\n|---|---|---|\n| 1 | 10,860 | 10,220 – 11,500 |\n| 2 | 10,940 | 10,280 – 11,600 |\n\n" +
      "Assumes no marketing push and no outage. A promo or a lost device would break it.",
  },
  {
    id: "pivot-a-table",
    category: "data-and-spreadsheets",
    title: "Pivot a flat table",
    pitch: "Rows become columns, totals are right, and the totals row adds up.",
    prompt:
      "Pivot the data in {{csv_path}} and write the result to {{output_path}}.\n\n" +
      "Requirements:\n" +
      "- Rows: {{row_dimension}}. Columns: {{column_dimension}}. Values: {{value_column}}, aggregated with {{aggregation}}.\n" +
      "- Include a totals column, a totals row, and make sure they add up. Verify it and say so.\n" +
      "- Rows and columns sorted by their total, largest first.\n" +
      "- Any cell with no data shows as an em dash, not 0.\n" +
      "- Also write a flat CSV version of the same pivot, one row per cell, with the row key, column key and value.\n\n" +
      "Use {{tool}}.",
    fields: [
      { name: "csv_path", label: "Source file", type: "text", default: "/workspace/uploads/sales.csv" },
      { name: "output_path", label: "Where to write the pivot", type: "text", default: "/workspace/reports/pivot.md" },
      { name: "row_dimension", label: "Rows", type: "text", default: "region" },
      { name: "column_dimension", label: "Columns", type: "text", default: "quarter" },
      { name: "value_column", label: "Values", type: "text", default: "revenue" },
      { name: "aggregation", label: "Aggregation", type: "select", options: ["sum", "average", "count", "max"], default: "sum" },
      { name: "tool", label: "Tool to use", type: "select", options: ["Python (pandas pivot_table)", "SQL (GROUP BY with ROLLUP)"], default: "Python (pandas pivot_table)" },
    ],
    role: "data-analyst",
    estimatedMinutes: 15,
    tools: ["read_file", "bash", "write_file"],
    mcp: [],
    example:
      "# Revenue by region and quarter\n\n" +
      "| Region | Q1 | Q2 | Q3 | Total |\n|---|---|---|---|---|\n| EMEA | 812,400 | 903,150 | — | 1,715,550 |\n| APAC | 640,100 | 712,880 | 655,200 | 2,008,180 |\n| AMER | 1,204,900 | 1,318,400 | 1,402,750 | 3,926,050 |\n| **Total** | 2,657,400 | 2,934,430 | 2,057,950 | 7,649,780 |\n\n" +
      "EMEA had no Q3 rows — shown as — and excluded from the Q3 total. Totals verified against a GROUP BY sum: they match.",
  },
  {
    id: "validate-a-dataset",
    category: "data-and-spreadsheets",
    title: "Validate a dataset",
    pitch: "Every rule checked, every violation located, and the file left as it was.",
    prompt:
      "Validate {{csv_path}} against these rules and write a report to {{output_path}}.\n\n" +
      "Rules:\n{{rules}}\n\n" +
      "For each rule:\n" +
      "- State how many rows violate it and list up to {{max_examples}} offending rows with their line number and the value that broke the rule.\n" +
      "- Say whether the violation looks like a broken value or a broken rule.\n" +
      "- Suggest the fix, but do not modify the data file.\n\n" +
      "End with a one-line verdict: is this dataset safe to use for {{purpose}}? Use {{tool}}.",
    fields: [
      { name: "csv_path", label: "Dataset", type: "text", default: "/workspace/uploads/users.csv" },
      { name: "output_path", label: "Where to write the report", type: "text", default: "/workspace/reports/validation.md" },
      { name: "rules", label: "Rules to check", type: "textarea", default: "email must contain an @ and a dot\nsignup_date must be between 2024-01-01 and today\ncountry must be a two-letter ISO code\nplan must be one of free, pro, team" },
      { name: "max_examples", label: "Example rows to list per rule", type: "text", default: "5" },
      { name: "purpose", label: "What the data is for", type: "text", default: "the monthly newsletter segmentation" },
      { name: "tool", label: "Tool to use", type: "select", options: ["Python (pandas)", "Python (csv module)", "SQL over SQLite"], default: "Python (pandas)" },
    ],
    role: "data-analyst",
    estimatedMinutes: 15,
    tools: ["read_file", "bash", "write_file"],
    mcp: [],
    example:
      "# Validation report — users.csv (12,884 rows)\n\n" +
      "1. email contains @ and a dot — 37 violations. Broken values (lines 402, 918, 2210: 'ada@localhost').\n" +
      "2. signup_date in range — 0 violations.\n" +
      "3. country is ISO-2 — 12 violations. Broken values (9 rows 'UK' instead of 'GB', 3 rows blank). Broken rule: UK is a legitimate value the rule should allow.\n" +
      "4. plan in {free, pro, team} — 4 violations, all 'enterprise' (line 3401 etc.). Broken rule: the rule is out of date.\n\n" +
      "Verdict: safe for newsletter segmentation once the country and plan rules are corrected.",
  },
  {
    id: "budget-vs-actual",
    category: "data-and-spreadsheets",
    title: "Compare budget to actuals",
    pitch: "Variance per line, the big movers called out, and no rounding that hides a number.",
    prompt:
      "Compare the budget in {{budget_path}} with the actuals in {{actuals_path}} and write a variance report to {{output_path}}.\n\n" +
      "Requirements:\n" +
      "- Match on {{join_key}}.\n" +
      "- Per line: budget, actual, variance in currency and variance as a percentage of budget.\n" +
      "- Flag every line whose absolute variance exceeds {{threshold_pct}} as over or under, and sort those to the top by size.\n" +
      "- Flag lines in the actuals with no budget, and budget lines with no actuals.\n" +
      "- One paragraph on what drove the largest variance — only if the data supports it; otherwise say the drivers are not visible in these two files.\n\n" +
      "Use {{tool}}.",
    fields: [
      { name: "budget_path", label: "Budget file", type: "text", default: "/workspace/uploads/budget.csv" },
      { name: "actuals_path", label: "Actuals file", type: "text", default: "/workspace/uploads/actuals.csv" },
      { name: "output_path", label: "Where to write the report", type: "text", default: "/workspace/reports/budget-variance.md" },
      { name: "join_key", label: "Join key", type: "text", default: "account_code" },
      { name: "threshold_pct", label: "Variance threshold (%)", type: "text", default: "10" },
      { name: "tool", label: "Tool to use", type: "select", options: ["Python (pandas)", "SQL over SQLite"], default: "Python (pandas)" },
    ],
    role: "data-analyst",
    estimatedMinutes: 20,
    tools: ["read_file", "bash", "write_file"],
    mcp: [],
    example:
      "# Budget vs actuals — variance over 10%\n\n" +
      "| Account | Budget | Actual | Variance | % |\n|---|---|---|---|---|\n| 6100 Hosting | 12,000 | 19,440 | +7,440 | +62.0% |\n| 6420 Travel | 8,000 | 3,120 | -4,880 | -61.0% |\n| 6300 Software | 20,000 | 20,010 | +10 | +0.1% |\n\n" +
      "Actual-only: 6990 Equipment (3,210). Budget-only: 6180 Bad Debt (5,000, no spend).\n" +
      "The hosting overspend of 7,440 matches the extra region added in March at roughly 2,480 per month; travel underspend is visible in the actuals but its cause is not.",
  },
];
