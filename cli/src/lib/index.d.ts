export declare function disconnect(): Promise<void>;
export declare function getUserName(): string | null;
export declare function isLoggedIn(): boolean;
export declare function login(): Promise<{
	tokens: unknown;
	userInfo: unknown;
}>;
export declare function logout(): void;
export declare function normalizePaperId(input: string): string;

export declare function searchAll(query: string): Promise<unknown>;
export declare function searchByEmbedding(query: string): Promise<unknown>;
export declare function searchByKeyword(query: string): Promise<unknown>;
export declare function agenticSearch(query: string): Promise<unknown>;

export declare function parsePaperSearchResults(
	text: unknown,
	options?: { includeRaw?: boolean },
): {
	results: unknown[];
	raw?: unknown;
};

export declare function searchPapers(
	query: string,
	mode?: "semantic" | "keyword" | "both" | "agentic" | "all" | string,
	options?: { includeRaw?: boolean },
): Promise<unknown>;

export declare function getPaper(
	identifier: string,
	options?: { fullText?: boolean },
): Promise<{
	paperId: string;
	url: string;
	alphaXivUrl: string;
	content: unknown;
	annotation: unknown;
}>;

export declare function askPaper(
	identifier: string,
	question: string,
): Promise<{
	paperId: string;
	url: string;
	alphaXivUrl: string;
	question: string;
	answer: unknown;
}>;

export declare function annotatePaper(
	identifier: string,
	note: string,
): Promise<{
	status: "saved";
	annotation: unknown;
}>;

export declare function clearPaperAnnotation(
	identifier: string,
): Promise<{
	status: "cleared" | "not_found";
	paperId: string;
}>;

export declare function getPaperAnnotation(
	identifier: string,
): Promise<{
	status: "found" | "no_annotation";
	annotation?: unknown;
	paperId?: string;
}>;

export declare function listPaperAnnotations(): Promise<{
	total: number;
	annotations: unknown[];
}>;

export declare function readPaperCode(githubUrl: string, path?: string): Promise<unknown>;

export declare function readAnnotation(id: string): unknown;
export declare function writeAnnotation(id: string, note: string): unknown;
export declare function clearAnnotation(id: string): boolean;
export declare function listAnnotations(): unknown[];
