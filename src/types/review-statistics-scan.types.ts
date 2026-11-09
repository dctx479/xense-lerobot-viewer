export type ReviewStatisticsScan = {
  roots: string[];
  recursive: boolean;
  directoriesScanned: number;
  truncated: boolean;
  duplicateMarks: number;
  conflictingMarks: number;
  sources: {
    path: string;
    directory: string;
    datasets: number;
    records: number;
  }[];
  warnings: { path: string; message: string }[];
};
