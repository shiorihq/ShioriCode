export class RunCommandResult {
  output = "";
  constructor(init: { output?: string } = {}) {
    this.output = init.output ?? "";
  }
  toJSON(): { output: string } {
    return { output: this.output };
  }
  toString(): string {
    return this.output;
  }
}

export class ListDirectoryEntry {
  name: string;
  isDirectory = false;
  fileSize = 0;
  constructor(init: {
    name: string;
    isDirectory?: boolean;
    is_directory?: boolean;
    fileSize?: number;
    file_size?: number;
  }) {
    if (init.name === undefined || init.name === null) {
      throw new Error("ListDirectoryEntry.name is required.");
    }
    this.name = init.name;
    this.isDirectory = init.isDirectory ?? init.is_directory ?? false;
    this.fileSize = init.fileSize ?? init.file_size ?? 0;
  }
  get is_directory(): boolean {
    return this.isDirectory;
  }
  set is_directory(value: boolean) {
    this.isDirectory = value;
  }
  get file_size(): number {
    return this.fileSize;
  }
  set file_size(value: number) {
    this.fileSize = value;
  }
  toJSON(): { name: string; is_directory: boolean; file_size: number } {
    return {
      name: this.name,
      is_directory: this.isDirectory,
      file_size: this.fileSize,
    };
  }
}

export class ListDirectoryResult {
  entries: ListDirectoryEntry[] = [];
  constructor(
    init: {
      entries?: Array<ListDirectoryEntry | ConstructorParameters<typeof ListDirectoryEntry>[0]>;
    } = {},
  ) {
    this.entries = (init.entries ?? []).map((entry) =>
      entry instanceof ListDirectoryEntry ? entry : new ListDirectoryEntry(entry),
    );
  }
  toJSON(): { entries: Array<ReturnType<ListDirectoryEntry["toJSON"]>> } {
    return { entries: this.entries.map((entry) => entry.toJSON()) };
  }
  toString(): string {
    return this.entries
      .map((entry) =>
        entry.isDirectory ? `${entry.name}/ (dir)` : `${entry.name} (${entry.fileSize} bytes)`,
      )
      .join("\n");
  }
}

export class SearchDirectoryResult {
  numResults = 0;
  constructor(init: { numResults?: number; num_results?: number } = {}) {
    this.numResults = init.numResults ?? init.num_results ?? 0;
  }
  get num_results(): number {
    return this.numResults;
  }
  set num_results(value: number) {
    this.numResults = value;
  }
  toJSON(): { num_results: number } {
    return { num_results: this.numResults };
  }
  toString(): string {
    return `${this.numResults} results`;
  }
}

export class FindFileResult {
  output = "";
  constructor(init: { output?: string } = {}) {
    this.output = init.output ?? "";
  }
  toJSON(): { output: string } {
    return { output: this.output };
  }
  toString(): string {
    return this.output;
  }
}

export class EditFileResult {
  summary = "";
  constructor(init: { summary?: string } = {}) {
    this.summary = init.summary ?? "";
  }
  toJSON(): { summary: string } {
    return { summary: this.summary };
  }
  toString(): string {
    return this.summary;
  }
}

export class GenerateImageResult {
  imageName = "";
  constructor(init: { imageName?: string; image_name?: string } = {}) {
    this.imageName = init.imageName ?? init.image_name ?? "";
  }
  get image_name(): string {
    return this.imageName;
  }
  set image_name(value: string) {
    this.imageName = value;
  }
  toJSON(): { image_name: string } {
    return { image_name: this.imageName };
  }
  toString(): string {
    return this.imageName;
  }
}

export class TextResult {
  text = "";
  constructor(init: { text?: string } = {}) {
    this.text = init.text ?? "";
  }
  toJSON(): { text: string } {
    return { text: this.text };
  }
  toString(): string {
    return this.text;
  }
}

export type ToolOutput =
  | RunCommandResult
  | ListDirectoryResult
  | SearchDirectoryResult
  | FindFileResult
  | EditFileResult
  | GenerateImageResult
  | TextResult;
