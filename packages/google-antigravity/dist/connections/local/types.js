export class RunCommandResult {
    output = "";
    constructor(init = {}) {
        this.output = init.output ?? "";
    }
    toJSON() {
        return { output: this.output };
    }
    toString() {
        return this.output;
    }
}
export class ListDirectoryEntry {
    name;
    isDirectory = false;
    fileSize = 0;
    constructor(init) {
        if (init.name === undefined || init.name === null) {
            throw new Error("ListDirectoryEntry.name is required.");
        }
        this.name = init.name;
        this.isDirectory = init.isDirectory ?? init.is_directory ?? false;
        this.fileSize = init.fileSize ?? init.file_size ?? 0;
    }
    get is_directory() {
        return this.isDirectory;
    }
    set is_directory(value) {
        this.isDirectory = value;
    }
    get file_size() {
        return this.fileSize;
    }
    set file_size(value) {
        this.fileSize = value;
    }
    toJSON() {
        return {
            name: this.name,
            is_directory: this.isDirectory,
            file_size: this.fileSize,
        };
    }
}
export class ListDirectoryResult {
    entries = [];
    constructor(init = {}) {
        this.entries = (init.entries ?? []).map((entry) => entry instanceof ListDirectoryEntry ? entry : new ListDirectoryEntry(entry));
    }
    toJSON() {
        return { entries: this.entries.map((entry) => entry.toJSON()) };
    }
    toString() {
        return this.entries
            .map((entry) => entry.isDirectory ? `${entry.name}/ (dir)` : `${entry.name} (${entry.fileSize} bytes)`)
            .join("\n");
    }
}
export class SearchDirectoryResult {
    numResults = 0;
    constructor(init = {}) {
        this.numResults = init.numResults ?? init.num_results ?? 0;
    }
    get num_results() {
        return this.numResults;
    }
    set num_results(value) {
        this.numResults = value;
    }
    toJSON() {
        return { num_results: this.numResults };
    }
    toString() {
        return `${this.numResults} results`;
    }
}
export class FindFileResult {
    output = "";
    constructor(init = {}) {
        this.output = init.output ?? "";
    }
    toJSON() {
        return { output: this.output };
    }
    toString() {
        return this.output;
    }
}
export class EditFileResult {
    summary = "";
    constructor(init = {}) {
        this.summary = init.summary ?? "";
    }
    toJSON() {
        return { summary: this.summary };
    }
    toString() {
        return this.summary;
    }
}
export class GenerateImageResult {
    imageName = "";
    constructor(init = {}) {
        this.imageName = init.imageName ?? init.image_name ?? "";
    }
    get image_name() {
        return this.imageName;
    }
    set image_name(value) {
        this.imageName = value;
    }
    toJSON() {
        return { image_name: this.imageName };
    }
    toString() {
        return this.imageName;
    }
}
export class TextResult {
    text = "";
    constructor(init = {}) {
        this.text = init.text ?? "";
    }
    toJSON() {
        return { text: this.text };
    }
    toString() {
        return this.text;
    }
}
//# sourceMappingURL=types.js.map