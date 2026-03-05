import { describe, test, expect } from '@jest/globals';
import {
  buildRepoBrowseUrl,
  detectGitPlatform,
  extractRepoFromGitUrl,
  buildPrepareSessionRepoParams,
} from './git-utils';

describe('buildRepoBrowseUrl', () => {
  test('GitHub HTTPS with .git', () => {
    expect(buildRepoBrowseUrl('https://github.com/owner/repo.git')).toBe(
      'https://github.com/owner/repo'
    );
  });

  test('GitHub HTTPS without .git', () => {
    expect(buildRepoBrowseUrl('https://github.com/owner/repo')).toBe(
      'https://github.com/owner/repo'
    );
  });

  test('GitHub SSH', () => {
    expect(buildRepoBrowseUrl('git@github.com:owner/repo.git')).toBe(
      'https://github.com/owner/repo'
    );
  });

  test('GitHub SSH without .git', () => {
    expect(buildRepoBrowseUrl('git@github.com:owner/repo')).toBe('https://github.com/owner/repo');
  });

  test('GitLab HTTPS', () => {
    expect(buildRepoBrowseUrl('https://gitlab.com/group/project.git')).toBe(
      'https://gitlab.com/group/project'
    );
  });

  test('GitLab nested groups', () => {
    expect(buildRepoBrowseUrl('https://gitlab.com/group/subgroup/project.git')).toBe(
      'https://gitlab.com/group/subgroup/project'
    );
  });

  test('GitLab SSH', () => {
    expect(buildRepoBrowseUrl('git@gitlab.com:group/project.git')).toBe(
      'https://gitlab.com/group/project'
    );
  });

  test('self-hosted HTTPS', () => {
    expect(buildRepoBrowseUrl('https://gitlab.mycompany.com/team/repo.git')).toBe(
      'https://gitlab.mycompany.com/team/repo'
    );
  });

  test('self-hosted SSH', () => {
    expect(buildRepoBrowseUrl('git@gitlab.mycompany.com:team/repo.git')).toBe(
      'https://gitlab.mycompany.com/team/repo'
    );
  });

  test('ssh:// URI format with .git', () => {
    expect(buildRepoBrowseUrl('ssh://git@github.com/owner/repo.git')).toBe(
      'https://github.com/owner/repo'
    );
  });

  test('ssh:// URI format without .git', () => {
    expect(buildRepoBrowseUrl('ssh://git@github.com/owner/repo')).toBe(
      'https://github.com/owner/repo'
    );
  });

  test('ssh:// URI format GitLab nested groups', () => {
    expect(buildRepoBrowseUrl('ssh://git@gitlab.com/group/subgroup/project.git')).toBe(
      'https://gitlab.com/group/subgroup/project'
    );
  });

  test('null returns undefined', () => {
    expect(buildRepoBrowseUrl(null)).toBeUndefined();
  });

  test('undefined returns undefined', () => {
    expect(buildRepoBrowseUrl(undefined)).toBeUndefined();
  });

  test('empty string returns undefined', () => {
    expect(buildRepoBrowseUrl('')).toBeUndefined();
  });
});

describe('detectGitPlatform', () => {
  test('GitHub HTTPS', () => {
    expect(detectGitPlatform('https://github.com/owner/repo.git')).toBe('github');
  });

  test('GitHub SSH', () => {
    expect(detectGitPlatform('git@github.com:owner/repo.git')).toBe('github');
  });

  test('GitLab HTTPS', () => {
    expect(detectGitPlatform('https://gitlab.com/group/project.git')).toBe('gitlab');
  });

  test('GitLab SSH', () => {
    expect(detectGitPlatform('git@gitlab.com:group/project.git')).toBe('gitlab');
  });

  test('self-hosted GitLab HTTPS returns undefined', () => {
    expect(detectGitPlatform('https://gitlab.mycompany.com/team/repo.git')).toBeUndefined();
  });

  test('self-hosted SSH returns undefined', () => {
    expect(detectGitPlatform('git@gitlab.mycompany.com:team/repo.git')).toBeUndefined();
  });

  test('GitHub ssh:// URI format', () => {
    expect(detectGitPlatform('ssh://git@github.com/owner/repo.git')).toBe('github');
  });

  test('GitLab ssh:// URI format', () => {
    expect(detectGitPlatform('ssh://git@gitlab.com/group/project.git')).toBe('gitlab');
  });

  test('Bitbucket returns undefined', () => {
    expect(detectGitPlatform('https://bitbucket.org/owner/repo.git')).toBeUndefined();
  });

  test('null returns undefined', () => {
    expect(detectGitPlatform(null)).toBeUndefined();
  });

  test('undefined returns undefined', () => {
    expect(detectGitPlatform(undefined)).toBeUndefined();
  });
});

describe('extractRepoFromGitUrl', () => {
  test('GitHub HTTPS with .git', () => {
    expect(extractRepoFromGitUrl('https://github.com/owner/repo.git')).toBe('owner/repo');
  });

  test('GitLab SSH nested groups', () => {
    expect(extractRepoFromGitUrl('git@gitlab.com:group/subgroup/project.git')).toBe(
      'group/subgroup/project'
    );
  });

  test('ssh:// URI format', () => {
    expect(extractRepoFromGitUrl('ssh://git@github.com/owner/repo.git')).toBe('owner/repo');
  });

  test('ssh:// URI format GitLab nested groups', () => {
    expect(extractRepoFromGitUrl('ssh://git@gitlab.com/group/subgroup/project.git')).toBe(
      'group/subgroup/project'
    );
  });

  test('null returns undefined', () => {
    expect(extractRepoFromGitUrl(null)).toBeUndefined();
  });
});

describe('buildPrepareSessionRepoParams', () => {
  test('github platform with repo', () => {
    expect(buildPrepareSessionRepoParams({ repo: 'owner/repo', platform: 'github' })).toEqual({
      githubRepo: 'owner/repo',
    });
  });

  test('gitlab platform with repo', () => {
    expect(buildPrepareSessionRepoParams({ repo: 'group/project', platform: 'gitlab' })).toEqual({
      gitlabProject: 'group/project',
    });
  });

  test('null repo returns null', () => {
    expect(buildPrepareSessionRepoParams({ repo: null, platform: 'github' })).toBeNull();
  });

  test('empty string repo returns null', () => {
    expect(buildPrepareSessionRepoParams({ repo: '', platform: 'github' })).toBeNull();
  });
});
