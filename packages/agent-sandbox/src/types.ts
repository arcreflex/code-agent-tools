export interface SandboxConfig {
  readonly ports: number[];
  readonly readonly: string[];
  readonly egress_allow_domains: string[];
}

export interface StartOptions {
  readonly branch?: string;
  readonly build?: boolean;
  readonly baseTag: string;
}

export interface ShellOptions extends StartOptions {
  readonly admin: boolean;
  readonly asRoot: boolean;
  readonly repoPath?: string;
}

export interface ExecOptions extends StartOptions {
  readonly admin?: boolean;
  readonly env?: string[];
  readonly printCmd?: boolean;
}

export interface BuildOptions {
  readonly baseTag: string;
}

export interface BuildBaseOptions {
  readonly tag: string;
  readonly claudeCodeVersion?: string;
  readonly codexVersion?: string;
  readonly gitDeltaVersion?: string;
  readonly astGrepVersion?: string;
}

export interface RepoInfo {
  readonly name: string;
  readonly path: string;
  readonly hash: string;
}

export interface RunCommandInfo {
  readonly image: string;
  readonly args: string[];
}

export interface ExecCommandInfo {
  readonly args: string[];
}
