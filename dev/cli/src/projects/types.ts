export interface ProjectCommand {
  description: string;
  run: (args: string[], root: string) => Promise<void>;
}

export interface ProjectDef {
  name: string;
  description: string;
  commands: Record<string, ProjectCommand>;
}
