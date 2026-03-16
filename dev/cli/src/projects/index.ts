import type { ProjectDef } from './types';
import { kiloclaw } from './kiloclaw';
import { codeReview } from './code-review';
import { autoFix } from './auto-fix';
import { appBuilder } from './app-builder';

export const projects: ProjectDef[] = [kiloclaw, codeReview, autoFix, appBuilder];

export function getProject(name: string): ProjectDef | undefined {
  return projects.find(p => p.name === name);
}

export function getProjectNames(): string[] {
  return projects.map(p => p.name);
}
