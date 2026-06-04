export declare class RunCommandResult {
    output: string;
    constructor(init?: {
        output?: string;
    });
    toJSON(): {
        output: string;
    };
    toString(): string;
}
export declare class ListDirectoryEntry {
    name: string;
    isDirectory: boolean;
    fileSize: number;
    constructor(init: {
        name: string;
        isDirectory?: boolean;
        is_directory?: boolean;
        fileSize?: number;
        file_size?: number;
    });
    get is_directory(): boolean;
    set is_directory(value: boolean);
    get file_size(): number;
    set file_size(value: number);
    toJSON(): {
        name: string;
        is_directory: boolean;
        file_size: number;
    };
}
export declare class ListDirectoryResult {
    entries: ListDirectoryEntry[];
    constructor(init?: {
        entries?: Array<ListDirectoryEntry | ConstructorParameters<typeof ListDirectoryEntry>[0]>;
    });
    toJSON(): {
        entries: Array<ReturnType<ListDirectoryEntry["toJSON"]>>;
    };
    toString(): string;
}
export declare class SearchDirectoryResult {
    numResults: number;
    constructor(init?: {
        numResults?: number;
        num_results?: number;
    });
    get num_results(): number;
    set num_results(value: number);
    toJSON(): {
        num_results: number;
    };
    toString(): string;
}
export declare class FindFileResult {
    output: string;
    constructor(init?: {
        output?: string;
    });
    toJSON(): {
        output: string;
    };
    toString(): string;
}
export declare class EditFileResult {
    summary: string;
    constructor(init?: {
        summary?: string;
    });
    toJSON(): {
        summary: string;
    };
    toString(): string;
}
export declare class GenerateImageResult {
    imageName: string;
    constructor(init?: {
        imageName?: string;
        image_name?: string;
    });
    get image_name(): string;
    set image_name(value: string);
    toJSON(): {
        image_name: string;
    };
    toString(): string;
}
export declare class TextResult {
    text: string;
    constructor(init?: {
        text?: string;
    });
    toJSON(): {
        text: string;
    };
    toString(): string;
}
export type ToolOutput = RunCommandResult | ListDirectoryResult | SearchDirectoryResult | FindFileResult | EditFileResult | GenerateImageResult | TextResult;
//# sourceMappingURL=types.d.ts.map