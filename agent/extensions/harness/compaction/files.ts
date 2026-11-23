/**
 * 要約の末尾に付ける、読んだファイル・変更したファイルの一覧。
 * pi の標準の要約(`core/compaction/utils.js` の `computeFileLists`・`formatFileOperations`、
 * `compaction.js` の `extractFileOperations`)と同じ作り方・書式にする。公開 API に無いので、同じ処理をここに書く。
 */

/** `preparation.fileOps` と同じ形 */
export interface FileOps {
  read: ReadonlySet<string>;
  written: ReadonlySet<string>;
  edited: ReadonlySet<string>;
}

export interface FileLists {
  /** 読んだだけのファイル(変更したものは除く)。昇順 */
  readFiles: string[];
  /** 変更したファイル(edit と write)。昇順 */
  modifiedFiles: string[];
}

/** 読んだだけのファイルと、変更したファイルに分ける(pi の `computeFileLists` と同じ) */
export function computeFileLists(fileOps: FileOps): FileLists {
  const modified = new Set([...fileOps.edited, ...fileOps.written]);
  const readFiles = [...fileOps.read].filter((f) => !modified.has(f)).sort();
  return { readFiles, modifiedFiles: [...modified].sort() };
}

/** 要約に付ける書式(pi の `formatFileOperations` と同じ)。どちらも空なら空文字 */
export function formatFileLists({ readFiles, modifiedFiles }: FileLists): string {
  const sections: string[] = [];
  if (readFiles.length > 0) sections.push(`<read-files>\n${readFiles.join("\n")}\n</read-files>`);
  if (modifiedFiles.length > 0) {
    sections.push(`<modified-files>\n${modifiedFiles.join("\n")}\n</modified-files>`);
  }
  return sections.length > 0 ? `\n\n${sections.join("\n\n")}` : "";
}

const stringArray = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];

/**
 * これまでの要約の一覧を引き継いだ fileOps を作る。
 * pi は、拡張が返した要約(`fromHook: true`)の details を `preparation.fileOps` に入れないので、
 * 枝のエントリ(`branchEntries`)の compaction エントリの details から自分で読む。
 * 拡張の要約と pi の標準の要約が交互に入ると、pi の標準の要約は直前の拡張の要約の一覧を持たないので、
 * 最後の 1 件ではなく、枝のすべての compaction エントリの details を足し合わせる。
 * pi の作り方と同じく、readFiles は read に、modifiedFiles は edited に入れる(集合なので重ならない)。
 */
export function withPreviousFileLists(
  fileOps: FileOps,
  branchEntries: readonly unknown[],
): FileOps {
  const read = new Set(fileOps.read);
  const edited = new Set(fileOps.edited);
  for (const e of branchEntries) {
    const entry = e as { type?: unknown; details?: unknown } | null;
    if (entry?.type !== "compaction") continue;
    const details = entry.details as { readFiles?: unknown; modifiedFiles?: unknown } | null;
    for (const f of stringArray(details?.readFiles)) read.add(f);
    for (const f of stringArray(details?.modifiedFiles)) edited.add(f);
  }
  return { read, written: new Set(fileOps.written), edited };
}
