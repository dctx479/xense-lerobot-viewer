import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { LocaleProvider } from "@/context/locale-context";
import { EpisodeReviewsProvider } from "@/context/episode-reviews-context";
import WorkbenchReviewStatistics from "@/components/workbench-review-statistics";
import { reviewDateRange } from "@/utils/reviewTime";
import {
  ReviewDailyWorkloadChart,
  ReviewMarkTrendChart,
} from "@/components/workbench-review-charts";
import { buildWorkbenchReviewDailyChart } from "@/utils/workbenchReviewStatistics";
import {
  WorkbenchReviewStatisticsOverview,
  WorkbenchReviewSources,
  WorkbenchReviewDateWindow,
  WorkbenchReviewCoverageDetails,
} from "@/components/workbench-review-statistics";
import { computeWorkbenchReviewStatistics } from "@/utils/workbenchReviewStatistics";
import { ReviewDwellTimeValue } from "@/components/review-dwell-time-value";

const statistics = computeWorkbenchReviewStatistics({
  version: 1,
  datasets: {
    "TacVerse/fixture": {
      version: 1,
      episodes: {
        "3": [
          {
            reviewer: "Alice",
            source: "episodes",
            reviewed_at: "2026-10-31T23:30:00+08:00",
          },
          {
            reviewer: "Bob",
            source: "urdf",
            reviewed_at: "2026-11-01T08:00:00+08:00",
          },
        ],
      },
    },
  },
});

test("renders the Chinese overview, accessible daily values, and both detail tables", () => {
  const html = renderToStaticMarkup(
    <LocaleProvider initialLocale="zh">
      <WorkbenchReviewStatisticsOverview statistics={statistics} />
    </LocaleProvider>,
  );
  for (const label of [
    "已质检 Episode",
    "待交叉复检 Episode",
    "已交叉复检 Episode",
    "质检标记人次",
    "质检人员工作量",
    "数据集质检明细",
    "每人每日检查量（UTC+8）",
    "已检查 Episode 数据时长",
    "已检查 Episode 帧数",
    "已检查 Episode 体量",
    "涉及数据集总规模（仅供参考）",
    "数据集检查覆盖（去重）",
  ])
    expect(html).toContain(label);
  expect(html).toContain("Alice");
  expect(html).toContain("Bob");
  expect(html).toContain("TacVerse/fixture");
  expect(html).toContain("2026-10-31");
  expect(html).toContain("2026-11-01");
  expect(html).toContain("overflow-x-auto");
  expect(html).not.toContain("合格率");
});

test("keeps expanded dataset details in separate full-width rows with unique controls", () => {
  const html = renderToStaticMarkup(
    <LocaleProvider initialLocale="zh">
      <WorkbenchReviewStatisticsOverview statistics={statistics} />
    </LocaleProvider>,
  );
  const summaryRows = [
    ...html.matchAll(/<tr data-review-row="summary"[\s\S]*?<\/tr>/g),
  ];
  const detailRows = [
    ...html.matchAll(/<tr data-review-row="details"[\s\S]*?<\/tr>/g),
  ];
  const expected = statistics.personDaily.length + statistics.people.length;
  expect(summaryRows).toHaveLength(expected);
  expect(detailRows).toHaveLength(expected);
  const ids = new Set<string>();
  summaryRows.forEach(([row], index) => {
    expect(row).not.toContain("data-coverage-dataset");
    expect(row).toContain('aria-expanded="false"');
    const id = row.match(/aria-controls="([^"]+)"/)?.[1];
    expect(id).toBeDefined();
    ids.add(id!);
    const detail = detailRows[index][0];
    expect(detail).toMatch(/<tr[^>]* hidden=""/);
    expect(detail).toMatch(/<td[^>]*colSpan="11"/);
    expect(detail).toContain('id="' + id + '" role="region"');
    expect(detail).toContain('aria-labelledby="' + id + '-title"');
    expect(detail).toContain('id="' + id + '-title"');
    expect(detail).toContain('id="' + id + '-search"');
    expect(detail).toContain('for="' + id + '-search"');
    expect(detail).toContain('type="search"');
    expect(detail).toContain('data-coverage-dataset="TacVerse/fixture"');
    expect(detail).not.toContain("overflow-y-auto");
    expect(detail).not.toContain("<section");
  });
  expect(ids.size).toBe(expected);
});

test("shows a searchable empty state for coverage details without datasets", () => {
  const empty = computeWorkbenchReviewStatistics({ version: 1, datasets: {} });
  const html = renderToStaticMarkup(
    <LocaleProvider initialLocale="zh">
      <WorkbenchReviewCoverageDetails
        coverage={empty.datasetCoverage}
        label="Alice"
        id="empty-detail"
        onClose={() => {}}
      />
    </LocaleProvider>,
  );
  expect(html).toContain("Alice · 数据集检查明细");
  expect(html).toContain("显示 0 / 0 个数据集");
  expect(html).toContain("没有匹配的数据集");
  expect(html).toContain("筛选数据集名称或路径");
  expect(html).not.toContain("data-coverage-dataset");
});

test("adaptive views keep a single copy of each record and label every stacked metric", () => {
  const html = renderToStaticMarkup(
    <LocaleProvider initialLocale="zh">
      <WorkbenchReviewStatisticsOverview statistics={statistics} />
    </LocaleProvider>,
  );
  const tables = [
    ...html.matchAll(
      /<table[^>]*data-review-table="([^"]+)"[^>]*>[\s\S]*?<\/table>/g,
    ),
  ];
  expect(tables.map(([, kind]) => kind)).toEqual([
    "daily",
    "people",
    "datasets",
    "scale",
  ]);
  const expectedRows = [
    statistics.personDaily.length,
    statistics.people.length,
    statistics.datasets.length,
    statistics.datasets.length,
  ];
  tables.forEach(([table], index) => {
    const titleId = table.match(/aria-labelledby="([^"]+)"/)?.[1];
    expect(titleId).toBeDefined();
    expect(html).toContain('id="' + titleId + '"');
    const bodies = [...table.matchAll(/<tbody[^>]*>[\s\S]*?<\/tbody>/g)];
    const rows = bodies
      .flatMap(([body]) => [...body.matchAll(/<tr[^>]*>[\s\S]*?<\/tr>/g)])
      .filter(
        ([row]) =>
          !row.includes('data-review-row="day"') &&
          !row.includes('data-review-row="details"'),
      );
    expect(rows).toHaveLength(expectedRows[index]);
    for (const [row] of rows)
      for (const [cell] of row.matchAll(/<(?:td|th)\b[^>]*>/g))
        expect(cell).toContain("data-label=");
  });
});

test("keeps summary rows compact while retaining timing and full dataset scale in expanded details", () => {
  const html = renderToStaticMarkup(
    <LocaleProvider initialLocale="zh">
      <WorkbenchReviewStatisticsOverview statistics={statistics} />
    </LocaleProvider>,
  );
  for (const [row] of html.matchAll(
    /<tr data-review-row="summary"[\s\S]*?<\/tr>/g,
  )) {
    expect(row).toContain('data-coverage-layout="compact"');
    expect(row).toContain('data-dwell-layout="compact"');
    const text = row.replace(/<[^>]*>/g, "");
    expect(text).toContain("已记录 0/1");
    expect(text).not.toContain("仅累计已知值");
    expect(text).not.toContain("00:00 前");
    expect(text).not.toContain("全量标记数据集时长");
    expect(text).toContain("本期时长覆盖");
    expect(text).toContain("累计");
  }
  for (const [row] of html.matchAll(
    /<tr data-review-row="details"[\s\S]*?<\/tr>/g,
  )) {
    expect(row).toContain("全量标记数据集时长");
  }
  for (const table of ["daily", "people"]) {
    const section = html
      .split('data-review-table="' + table + '"')[1]
      .split("</table>")[0];
    expect([...section.matchAll(/<col\b/g)]).toHaveLength(11);
  }
});

test("dwell display distinguishes legacy unknown from recorded zero and snapshot duration", () => {
  const render = (milliseconds: number | null, knownRecords: number) =>
    renderToStaticMarkup(
      <LocaleProvider initialLocale="zh">
        <ReviewDwellTimeValue
          dwell={{
            records: 2,
            knownRecords,
            milliseconds,
            episodeDurationMilliseconds: milliseconds === null ? null : 30000,
          }}
          details
        />
      </LocaleProvider>,
    );
  expect(render(null, 0)).toContain("未知");
  expect(render(null, 0)).toContain("已记录 0/2 个标记");
  expect(render(null, 0)).not.toContain(">0 秒<");
  expect(render(0, 1)).toContain(">0 秒<");
  expect(render(1500, 1)).toContain("1.5 秒");
  expect(render(1500, 1)).toContain("对应 Episode 时长快照（按人次）");
  expect(render(1500, 1)).toContain("30 秒");
  const html = renderToStaticMarkup(
    <LocaleProvider initialLocale="zh">
      <WorkbenchReviewStatisticsOverview statistics={statistics} />
    </LocaleProvider>,
  );
  expect(html).toContain("已记录停留时间（前台）");
  expect(html).toContain('value="dwellSeconds"');
  for (const [row] of html.matchAll(
    /<tr data-review-row="summary"[\s\S]*?<\/tr>/g,
  ))
    expect([...row.matchAll(/<(?:td|th)\b/g)]).toHaveLength(11);
  const datasets = html
    .split('aria-label="数据集质检明细"')[1]
    .split("</section>")[0];
  for (const [row] of datasets.matchAll(/<tr\b[^>]*>[\s\S]*?<\/tr>/g))
    expect([...row.matchAll(/<(?:td|th)\b/g)]).toHaveLength(12);
});

test("dwell chart explains missing saved snapshots and keeps valid zero values", () => {
  const rows = buildWorkbenchReviewDailyChart(statistics, "dwellSeconds");
  const html = renderToStaticMarkup(
    <LocaleProvider initialLocale="zh">
      <ReviewDailyWorkloadChart rows={rows} metric="dwellSeconds" />
    </LocaleProvider>,
  );
  expect(html).toContain("缺少完整停留快照");
  expect(html).toContain("已记录停留时间（前台）");
  expect(html).not.toContain("GiB");
  const complete = computeWorkbenchReviewStatistics({
    version: 1,
    datasets: {
      dataset: {
        version: 1,
        episodes: {
          "0": [0, 1500].map((stay_ms, index) => ({
            reviewer: index === 0 ? "Alice" : "Bob",
            source: "episodes" as const,
            reviewed_at: "2026-11-01T00:00:00+08:00",
            stay_ms,
            episode_duration_ms: 10000,
          })),
        },
      },
    },
  });
  const completeRows = buildWorkbenchReviewDailyChart(complete, "dwellSeconds");
  expect(completeRows.map((row) => row.value)).toEqual([0, 1500 / 3_600_000]);
  const chart = renderToStaticMarkup(
    <LocaleProvider initialLocale="zh">
      <ReviewDailyWorkloadChart rows={completeRows} metric="dwellSeconds" />
    </LocaleProvider>,
  );
  expect(chart).toContain("小时");
  expect(chart).toContain("Alice");
  expect(chart).toContain("Bob");
  expect(chart).not.toContain("缺少完整停留快照");
  expect(chart).not.toContain("NaN");
  const bars = [
    ...chart.matchAll(/<path[^>]*class="[^"]*recharts-rectangle[^"]*"[^>]*>/g),
  ];
  expect(
    bars.some(([bar]) => Number(bar.match(/width="([^"]+)"/)?.[1]) > 0),
  ).toBe(true);
});

test("renders weighted workload, shared file estimates and missing metadata coverage explicitly", () => {
  const weighted = computeWorkbenchReviewStatistics(
    {
      version: 1,
      datasets: {
        dataset: {
          version: 1,
          episodes: {
            "0": [
              {
                reviewer: "Alice",
                source: "episodes",
                reviewed_at: "2026-11-01T08:00:00+08:00",
              },
            ],
            "1": [
              {
                reviewer: "Alice",
                source: "episodes",
                reviewed_at: "2026-11-01T09:00:00+08:00",
              },
            ],
          },
        },
      },
    },
    {},
    {
      dataset: {
        episodes: {
          "0": {
            frames: 108000,
            durationSeconds: 3600,
            sizeBytes: 2 * 1024 ** 3,
            sizeEstimated: true,
          },
        },
        totalEpisodes: 2,
        totalFrames: 216000,
        totalDurationSeconds: 7200,
        totalSizeBytes: 4 * 1024 ** 3,
        estimates: {
          totalDurationSeconds: { sampleEpisodes: 1, totalEpisodes: 2 },
        },
      },
    },
  );
  const html = renderToStaticMarkup(
    <LocaleProvider initialLocale="zh">
      <WorkbenchReviewStatisticsOverview statistics={weighted} />
    </LocaleProvider>,
  );
  expect(html).toContain("1.00 小时");
  expect(html).toContain("≈ 2 GiB");
  expect(html).toContain("已知 1/2");
  expect(html).toContain("不等于人工工时");
  expect(html).toContain("Episode 覆盖");
  expect(html).toContain("108,000");
  expect(html).not.toContain("NaN");
  expect(html).not.toContain("Infinity");
  const checkedSection = html
    .split('aria-label="数据集质检明细"')[1]
    .split("</section>")[0];
  const scaleSection = html
    .split('aria-label="涉及数据集总规模（仅供参考）"')[1]
    .split("</section>")[0];
  expect(checkedSection).toContain("1.00 小时");
  const measuredDuration = checkedSection
    .split('data-workload-metric="durationSeconds">')[1]
    .split("</div>")[0];
  expect(measuredDuration).toContain("1.00 小时");
  expect(measuredDuration).not.toContain("2.00 小时");
  expect(scaleSection).toContain("2.00 小时");
  expect(scaleSection).not.toContain("1.00 小时");
  expect(scaleSection).toContain("≈ 2.00 小时");
  expect(scaleSection).toContain("1/2");
  const personalSection = html
    .split('aria-label="质检人员工作量"')[1]
    .split("</section>")[0];
  expect(personalSection).toContain("数据集检查覆盖（去重）");
  const fullyMarked = personalSection
    .split('data-coverage="fully-marked-duration">')[1]
    .split("</div>")[0];
  expect(fullyMarked).not.toContain("2.00 小时");
  expect(fullyMarked).toContain("0.00 小时");
  expect(personalSection).toContain("0.00 小时");
  expect(personalSection).toContain("全量标记 0 · 部分 1 · 待核验 0");
  expect(personalSection).toContain("已隔离无法匹配标记 1");
  expect(personalSection).toContain("1.00 小时");
});

test("shows episode counts independently from content weights and displays missing-weight bounds", () => {
  for (const [weights, checked, total, quantity, duration] of [
    [[1, 999], [0], 1000, "50%", "0.1%"],
    [[10, null, 60, null], [0, 1], 100, "50%", "10%–40%"],
    [[10, null, 60], [0, 1], 100, "66.66%", "40%"],
  ] as const) {
    const record = {
      reviewer: "Alice",
      source: "episodes" as const,
      reviewed_at: "2026-11-01T09:00:00+08:00",
    };
    const stats = computeWorkbenchReviewStatistics(
      {
        version: 1,
        datasets: {
          dataset: {
            version: 1,
            episodes: Object.fromEntries(
              checked.map((id) => [String(id), [record]]),
            ),
          },
        },
      },
      {},
      {
        dataset: {
          episodeManifestComplete: true,
          totalEpisodes: weights.length,
          totalFrames: total * 30,
          totalDurationSeconds: total,
          totalSizeBytes: null,
          episodes: Object.fromEntries(
            weights.map((weight, id) => [
              String(id),
              {
                frames: weight === null ? null : weight * 30,
                durationSeconds: weight,
                sizeBytes: null,
                sizeEstimated: false,
              },
            ]),
          ),
        },
      },
    );
    const html = renderToStaticMarkup(
      <LocaleProvider initialLocale="zh">
        <WorkbenchReviewStatisticsOverview statistics={stats} />
      </LocaleProvider>,
    );
    const personal = html
      .split('aria-label="质检人员工作量"')[1]
      .split("</section>")[0]
      .replace(/<[^>]*>/g, "");
    expect(personal).toContain("Episode 覆盖: " + quantity);
    expect(personal).toContain("本期时长覆盖 " + duration);
    expect(personal).not.toContain("清单内全部已标记");
  }
});

test("shows discovery sources and prominently flags incomplete or conflicting scans", () => {
  const html = renderToStaticMarkup(
    <LocaleProvider initialLocale="zh">
      <WorkbenchReviewSources
        scan={{
          roots: ["/data/one", "/data/two"],
          recursive: true,
          directoriesScanned: 12,
          truncated: true,
          duplicateMarks: 3,
          conflictingMarks: 1,
          sources: [
            {
              path: "/data/one/nested/.xense-viewer/episode-reviews.json",
              directory: "/data/one/nested",
              datasets: 1,
              records: 20,
            },
          ],
          warnings: [
            {
              path: "/data/two/episode-reviews.json",
              message: "Invalid review file",
            },
          ],
        }}
      />
    </LocaleProvider>,
  );
  expect(html).toContain("读取 1 个记录文件");
  expect(html).toContain("去重标记 3");
  expect(html).toContain("当前统计不完整");
  expect(html).toContain("重复快照冲突");
  expect(html).toContain("/data/one/nested/.xense-viewer/episode-reviews.json");
  expect(html).toContain("Invalid review file");
  expect(html).toContain('role="alert"');
});

test("one checked episode shows partial progress without crediting the full dataset duration", () => {
  const stats = computeWorkbenchReviewStatistics(
    {
      version: 1,
      datasets: {
        dataset: {
          version: 1,
          episodes: {
            "0": [
              {
                reviewer: "Alice",
                source: "episodes",
                reviewed_at: "2026-11-01T08:00:00+08:00",
              },
            ],
          },
        },
      },
    },
    {},
    {
      dataset: {
        episodeManifestComplete: false,
        totalEpisodes: 1000,
        totalFrames: 108000000,
        totalDurationSeconds: 3600000,
        totalSizeBytes: null,
        episodes: {
          "0": {
            frames: 108000,
            durationSeconds: 3600,
            sizeBytes: null,
            sizeEstimated: false,
          },
        },
      },
    },
  );
  const html = renderToStaticMarkup(
    <LocaleProvider initialLocale="zh">
      <WorkbenchReviewStatisticsOverview statistics={stats} />
    </LocaleProvider>,
  );
  const personal = html
    .split('aria-label="质检人员工作量"')[1]
    .split("</section>")[0];
  expect(personal).toContain("1.00 小时");
  expect(personal).toContain("0.00 小时");
  expect(personal).toContain("全量标记 0 · 部分 1 · 待核验 0");
  expect(personal).toContain("1 / 1,000");
  expect(personal).toContain("清单内部分已标记");
  expect(personal).toContain("0.1%");
  expect(
    personal
      .split('data-coverage="fully-marked-duration">')[1]
      .split("</div>")[0],
  ).toContain("0.00 小时");
});

test("a verified single-episode dataset displays complete coverage and its real duration", () => {
  const stats = computeWorkbenchReviewStatistics(
    {
      version: 1,
      datasets: {
        dataset: {
          version: 1,
          episodes: {
            "7": [
              {
                reviewer: "Alice",
                source: "episodes",
                reviewed_at: "2026-11-01T08:00:00+08:00",
              },
            ],
          },
        },
      },
    },
    {},
    {
      dataset: {
        episodeManifestComplete: true,
        totalEpisodes: 1,
        totalFrames: 108000,
        totalDurationSeconds: 3600,
        totalSizeBytes: null,
        episodes: {
          "7": {
            frames: 108000,
            durationSeconds: 3600,
            sizeBytes: null,
            sizeEstimated: false,
          },
        },
      },
    },
  );
  const html = renderToStaticMarkup(
    <LocaleProvider initialLocale="en">
      <WorkbenchReviewStatisticsOverview statistics={stats} />
    </LocaleProvider>,
  );
  const personal = html
    .split('aria-label="Inspector workload"')[1]
    .split("</section>")[0];
  expect(personal).toContain("Dataset inspection coverage (unique)");
  expect(personal).toContain("All marked 1 · partial 0 · unverified 0");
  expect(personal).toContain("1 / 1");
  expect(personal).toContain("1.00 h");
});

test("date inputs start on the UTC+8 current day and expose explicit range presets", () => {
  const html = renderToStaticMarkup(
    <LocaleProvider initialLocale="zh">
      <EpisodeReviewsProvider repoId="local:/data/dataset" browsePath="/data">
        <WorkbenchReviewStatistics />
      </EpisodeReviewsProvider>
    </LocaleProvider>,
  );
  const dates = [...html.matchAll(/<input[^>]*type="date"[^>]*>/g)].map(
    ([input]) => input.match(/value="([^"]*)"/)?.[1],
  );
  expect(dates).toEqual([
    reviewDateRange().startDate,
    reviewDateRange().endDate,
  ]);
  expect(html).toMatch(/<button[^>]*aria-pressed="true"[^>]*>今天<\/button>/);
  expect(html).toContain("近 7 天");
  expect(html).toContain("全部日期");
  expect(html).toContain("默认查看今天（UTC+8）");
  expect(html).toContain('data-date-boundary="utc8-midnight"');
  expect(html).toContain("结束日期（当日 00:00，不含）");
  expect(html).toContain(
    `筛选时间：${dates[0]} 00:00（含）至 ${dates[1]} 00:00（不含），UTC+8`,
  );
  expect(html).not.toContain("实际筛选：");
});

test("review range captions match selected dates for bounded and open ranges", () => {
  for (const [startDate, endDate, zh, en] of [
    [
      "2026-11-01",
      "2026-11-02",
      "筛选时间：2026-11-01 00:00（含）至 2026-11-02 00:00（不含），UTC+8",
      "Selected window: 2026-11-01 00:00 (inclusive) to 2026-11-02 00:00 (exclusive), UTC+8",
    ],
    [
      "2026-11-02",
      "2026-11-02",
      "筛选时间：2026-11-02 00:00（含）至 2026-11-02 00:00（不含），UTC+8",
      "Selected window: 2026-11-02 00:00 (inclusive) to 2026-11-02 00:00 (exclusive), UTC+8",
    ],
    [
      "2026-11-01",
      "",
      "筛选时间：2026-11-01 00:00 起（含），结束日期不限，UTC+8",
      "Selected window: from 2026-11-01 00:00 (inclusive), no end date, UTC+8",
    ],
    [
      "",
      "2026-11-02",
      "筛选时间：2026-11-02 00:00 前（不含），开始日期不限，UTC+8",
      "Selected window: before 2026-11-02 00:00 (exclusive), no start date, UTC+8",
    ],
    [
      "",
      "",
      "筛选时间：全部日期（UTC+8）",
      "Selected window: all dates (UTC+8)",
    ],
  ]) {
    for (const locale of ["zh", "en"] as const) {
      const html = renderToStaticMarkup(
        <LocaleProvider initialLocale={locale}>
          <WorkbenchReviewDateWindow startDate={startDate} endDate={endDate} />
        </LocaleProvider>,
      );
      expect(html).toContain(locale === "zh" ? zh : en);
      expect(html).not.toContain("2026-11-03");
    }
  }
});

test("React 19 charts render real nonzero bars and explicitly separate active dates", () => {
  const html = renderToStaticMarkup(
    <LocaleProvider initialLocale="zh">
      <WorkbenchReviewStatisticsOverview statistics={statistics} />
    </LocaleProvider>,
  );
  expect(
    [...html.matchAll(/data-chart-day="([^"]+)"/g)].map((match) => match[1]),
  ).toEqual(["2026-10-31", "2026-11-01"]);
  expect(
    [...html.matchAll(/data-detail-day="([^"]+)"/g)].map((match) => match[1]),
  ).toEqual(["2026-10-31", "2026-11-01"]);
  expect(html).toContain("1 人 · 1 个标记");
  const rows = buildWorkbenchReviewDailyChart(statistics, "records");
  const chart = renderToStaticMarkup(
    <LocaleProvider initialLocale="en">
      <ReviewDailyWorkloadChart rows={rows} metric="records" />
    </LocaleProvider>,
  );
  const paths = [
    ...chart.matchAll(/<path[^>]*class="[^"]*recharts-rectangle[^"]*"[^>]*>/g),
  ].map((match) => match[0]);
  expect(
    paths.some(
      (path) =>
        path.includes('fill="#22d3ee"') &&
        Number(path.match(/width="([^"]+)"/)?.[1]) > 0,
    ),
  ).toBe(true);
  expect(
    paths.some(
      (path) =>
        path.includes('fill="#34d399"') &&
        Number(path.match(/width="([^"]+)"/)?.[1]) > 0,
    ),
  ).toBe(true);
  const trend = renderToStaticMarkup(
    <LocaleProvider initialLocale="en">
      <ReviewMarkTrendChart statistics={statistics} />
    </LocaleProvider>,
  );
  expect(trend).toContain("recharts-bar-rectangle");
  expect(trend).not.toContain("NaN");
});

test("coverage detail explains inferred ratios and keeps measured contribution visible", () => {
  const stats = computeWorkbenchReviewStatistics(
    {
      version: 1,
      datasets: {
        "/root/data": {
          version: 1,
          episodes: {
            "0": [
              {
                reviewer: "Alice",
                source: "episodes",
                reviewed_at: "2026-11-01T08:00:00+08:00",
              },
            ],
            "1": [
              {
                reviewer: "Alice",
                source: "episodes",
                reviewed_at: "2026-11-01T08:00:00+08:00",
              },
            ],
          },
        },
      },
    },
    {},
    {
      "/root/data": {
        episodeManifestComplete: true,
        totalEpisodes: 3,
        totalFrames: null,
        totalDurationSeconds: 100,
        totalSizeBytes: null,
        episodes: Object.fromEntries(
          [10, null, 60].map((duration, index) => [
            String(index),
            {
              frames: null,
              durationSeconds: duration,
              sizeBytes: null,
              sizeEstimated: false,
            },
          ]),
        ),
      },
    },
  );
  const html = renderToStaticMarkup(
    <LocaleProvider initialLocale="zh">
      <WorkbenchReviewStatisticsOverview statistics={stats} />
    </LocaleProvider>,
  );
  expect(html).toContain("检查覆盖总览");
  expect(html).toContain("40%");
  expect(html).toContain("覆盖比例由完整清单、全量值和未检查明细推导");
  expect(html).toContain("已知量");
  const workload = html
    .split('data-workload-metric="durationSeconds">')[1]
    .split("</div>")[0];
  expect(workload).toContain("10 秒");
  expect(workload).not.toContain("0.00 小时");
  expect(html).toContain('title="/root/data"');
  expect(html).toContain("max-h-[560px]");
  expect(html).toContain("sticky top-0");
});

test("daily charts explicitly identify missing metric values instead of drawing zero workload", () => {
  const rows = buildWorkbenchReviewDailyChart(statistics, "durationSeconds");
  expect(rows.every((row) => row.value === null)).toBe(true);
  const html = renderToStaticMarkup(
    <LocaleProvider initialLocale="zh">
      <ReviewDailyWorkloadChart rows={rows} metric="durationSeconds" />
    </LocaleProvider>,
  );
  expect(html).toContain(rows.length + " 个人日的指标不完整，未绘制数值");
  expect(html).toContain("请查看明细中的已知量");
  const counts = renderToStaticMarkup(
    <LocaleProvider initialLocale="en">
      <ReviewDailyWorkloadChart
        rows={buildWorkbenchReviewDailyChart(statistics, "records")}
        metric="records"
      />
    </LocaleProvider>,
  );
  expect(counts).toContain("Saved inspection marks");
  expect(counts).not.toContain("metrics are incomplete");
});

test("localizes the overview and explains an empty filtered range", () => {
  const empty = computeWorkbenchReviewStatistics({ version: 1, datasets: {} });
  const html = renderToStaticMarkup(
    <LocaleProvider initialLocale="en">
      <WorkbenchReviewStatisticsOverview statistics={empty} />
    </LocaleProvider>,
  );
  expect(html).toContain("Inspected episodes");
  expect(html).toContain("No saved inspection marks match this selection.");
  expect(html).not.toContain("NaN");
});

test("separate day panels keep proportional bar lengths on a shared scale", () => {
  const rows = buildWorkbenchReviewDailyChart(statistics, "records").map(
    (row, index) => ({
      ...row,
      records: index === 0 ? 10 : 5,
      value: index === 0 ? 10 : 5,
      initialInspections: index === 0 ? 10 : 5,
      crossReviews: 0,
    }),
  );
  const html = renderToStaticMarkup(
    <LocaleProvider initialLocale="en">
      <ReviewDailyWorkloadChart rows={rows} metric="records" />
    </LocaleProvider>,
  );
  const widths = [
    ...html.matchAll(/<path[^>]*class="[^"]*recharts-rectangle[^"]*"[^>]*>/g),
  ]
    .map((match) => match[0])
    .filter((path) => path.includes('fill="#22d3ee"'))
    .map((path) => Number(path.match(/width="([^"]+)"/)?.[1]));
  expect(widths).toHaveLength(2);
  expect(widths[0] / widths[1]).toBeCloseTo(2);
});

test("sub-hour and sub-GiB workloads retain a visible scale and nonzero axis labels", () => {
  for (const metric of ["durationSeconds", "sizeBytes"] as const) {
    const rows = buildWorkbenchReviewDailyChart(statistics, "records").map(
      (row, index) => ({ ...row, value: index === 0 ? 0.00002 : 0.00001 }),
    );
    const html = renderToStaticMarkup(
      <LocaleProvider initialLocale="en">
        <ReviewDailyWorkloadChart rows={rows} metric={metric} />
      </LocaleProvider>,
    );
    const widths = [
      ...html.matchAll(/<path[^>]*class="[^"]*recharts-rectangle[^"]*"[^>]*>/g),
    ]
      .map((match) => match[0])
      .filter((path) => path.includes('fill="#22d3ee"'))
      .map((path) => Number(path.match(/width="([^"]+)"/)?.[1]));
    expect(widths).toHaveLength(2);
    expect(widths[0]).toBeGreaterThan(250);
    expect(widths[0] / widths[1]).toBeCloseTo(2);
    expect(html).toContain("0.00002");
  }
});
