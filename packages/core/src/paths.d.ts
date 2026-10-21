/** The home directory, read when asked: a test that sets HOME after importing core
 *  (or a process whose HOME changes) gets the new one, never one cached at load. */
export declare const homeDir: () => string;
export declare function configFile(env?: NodeJS.ProcessEnv): string;
export declare function stateDir(env?: NodeJS.ProcessEnv): string;
/** `~` for the home directory, as the session block writes paths. */
export declare function tilde(p: string, home?: string): string;
/** A file-name-safe id. */
export declare const safeId: (s: string) => string;
//# sourceMappingURL=paths.d.ts.map
