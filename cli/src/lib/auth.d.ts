export declare function getAccessToken(): string | null;
export declare function getUserId(): string | null;
export declare function getUserName(): string | null;
export declare function refreshAccessToken(): Promise<string | null>;
export declare function login(): Promise<{
	tokens: unknown;
	userInfo: unknown;
}>;
export declare function getValidToken(): Promise<string | null>;
export declare function verifyLogin(): Promise<
	| { loggedIn: true; name: string | null }
	| { loggedIn: false; reason: "missing" | "expired" }
>;
export declare function isLoggedIn(): boolean;
export declare function logout(): void;
