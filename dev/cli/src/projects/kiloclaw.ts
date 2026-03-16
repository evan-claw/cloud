import type { ProjectDef } from './types';
import { run } from '../utils/process';
import * as ui from '../utils/ui';
import { parseEnvFile } from '../utils/env';
import { join } from 'path';

function setDevVar(content: string, key: string, value: string): string {
  const pattern = new RegExp(`^${key}=.*`, 'm');
  if (pattern.test(content)) {
    return content.replace(pattern, `${key}=${value}`);
  }
  const sep = content.endsWith('\n') ? '' : '\n';
  return content + `${sep}${key}=${value}\n`;
}

export const kiloclaw: ProjectDef = {
  name: 'kiloclaw',
  description: 'KiloClaw controller and worker services',
  commands: {
    setup: {
      description: 'Initialize KiloClaw dev environment (secrets, Vercel env, Fly token)',
      async run(_args: string[], root: string): Promise<void> {
        const kiloclawDir = join(root, 'kiloclaw');
        const devVarsPath = join(kiloclawDir, '.dev.vars');
        const devVarsExamplePath = join(kiloclawDir, '.dev.vars.example');

        // 1. Create .dev.vars from example if it doesn't exist
        const devVarsFile = Bun.file(devVarsPath);
        if (!(await devVarsFile.exists())) {
          ui.header('Creating .dev.vars from .dev.vars.example...');
          const example = await Bun.file(devVarsExamplePath).text();
          await Bun.write(devVarsPath, example);
          ui.success('Created .dev.vars');
        }

        // 2. Check AGENT_ENV_VARS_PRIVATE_KEY
        ui.header('Checking AGENT_ENV_VARS_PRIVATE_KEY...');
        let devVarsContent = await Bun.file(devVarsPath).text();
        const devVars = parseEnvFile(devVarsContent);
        const agentKey = devVars['AGENT_ENV_VARS_PRIVATE_KEY'];
        if (!agentKey || agentKey === '...') {
          ui.error('AGENT_ENV_VARS_PRIVATE_KEY is not configured in .dev.vars.');
          ui.error('Get the dev version from 1Password (engineering vault)');
          ui.error(`Set it in ${devVarsPath}`);
          process.exit(1);
        }
        ui.success('AGENT_ENV_VARS_PRIVATE_KEY is set');

        // 3. Check Vercel link
        ui.header('Checking Vercel link...');
        const vercelProjectJson = Bun.file(join(root, '.vercel', 'project.json'));
        if (!(await vercelProjectJson.exists())) {
          ui.error('Vercel project not linked.');
          ui.error(`Run 'vercel link' in ${root} first.`);
          process.exit(1);
        }
        ui.success('Vercel project linked');

        // 4. Pull Vercel env
        ui.header('Pulling development environment from Vercel...');
        const vercelOk = await run({
          command: 'vercel env pull --environment=development',
          cwd: root,
          label: 'vercel env pull --environment=development',
        });
        if (!vercelOk) {
          ui.error('Failed to pull Vercel env. Is vercel CLI installed and logged in?');
          process.exit(1);
        }

        // 5. Sync secrets from .env.local → .dev.vars
        const envLocalPath = join(root, '.env.local');
        const envLocalFile = Bun.file(envLocalPath);
        if (await envLocalFile.exists()) {
          ui.header('Syncing secrets from .env.local into .dev.vars...');
          const envLocalContent = await envLocalFile.text();
          const envLocal = parseEnvFile(envLocalContent);

          // Reload devVarsContent after Vercel pull (it may have changed the file)
          devVarsContent = await Bun.file(devVarsPath).text();

          const nextauthSecret = envLocal['NEXTAUTH_SECRET'];
          if (nextauthSecret) {
            devVarsContent = setDevVar(devVarsContent, 'NEXTAUTH_SECRET', nextauthSecret);
            ui.success('Synced NEXTAUTH_SECRET');
          }

          const internalApiSecret = envLocal['KILOCLAW_INTERNAL_API_SECRET'];
          if (internalApiSecret) {
            devVarsContent = setDevVar(devVarsContent, 'INTERNAL_API_SECRET', internalApiSecret);
            ui.success('Synced KILOCLAW_INTERNAL_API_SECRET → INTERNAL_API_SECRET');
          }

          await Bun.write(devVarsPath, devVarsContent);
        }

        // 6. Validate/refresh Fly API token
        ui.header('Validating Fly API token...');

        // Reload after any writes above
        devVarsContent = await Bun.file(devVarsPath).text();
        const devVarsCurrent = parseEnvFile(devVarsContent);

        const flyOrg = devVarsCurrent['FLY_ORG_SLUG'] || 'kilo-dev';
        let flyToken = devVarsCurrent['FLY_API_TOKEN'] || '';

        const generateFlyToken = async (): Promise<string> => {
          ui.header(`Generating new Fly API token for org '${flyOrg}'...`);
          const proc = Bun.spawn(['fly', 'tokens', 'create', 'org', flyOrg], {
            cwd: root,
            stdout: 'pipe',
            stderr: 'pipe',
          });
          const code = await proc.exited;
          const output = await new Response(proc.stdout).text();
          const errOutput = await new Response(proc.stderr).text();
          if (code !== 0 || !output.trim()) {
            ui.error("Failed to create Fly token. Are you logged in? Try 'fly auth login'.");
            if (errOutput) ui.error(errOutput.trim());
            process.exit(1);
          }
          const token = output.trim();
          devVarsContent = setDevVar(devVarsContent, 'FLY_API_TOKEN', token);
          await Bun.write(devVarsPath, devVarsContent);
          ui.success('Token saved to .dev.vars.');
          return token;
        };

        if (!flyToken || flyToken === 'fo1_...') {
          flyToken = await generateFlyToken();
        }

        // Validate token
        const validateToken = async (token: string): Promise<boolean> => {
          const proc = Bun.spawn(
            [
              'curl',
              '-s',
              '-o',
              '/dev/null',
              '-w',
              '%{http_code}',
              '-H',
              `Authorization: Bearer ${token}`,
              `https://api.machines.dev/v1/apps?org_slug=${flyOrg}&limit=1`,
            ],
            { cwd: root, stdout: 'pipe', stderr: 'pipe' }
          );
          await proc.exited;
          const status = (await new Response(proc.stdout).text()).trim();
          return status === '200';
        };

        let tokenValid = await validateToken(flyToken);
        if (!tokenValid) {
          ui.warn(`Token is invalid or expired. Refreshing...`);
          flyToken = await generateFlyToken();
          tokenValid = await validateToken(flyToken);
          if (!tokenValid) {
            ui.error("New token still failing. Check 'fly auth login' and org access.");
            process.exit(1);
          }
        }

        ui.success('Fly API token is valid.');
        console.log('');
        ui.success('KiloClaw dev environment is ready!');
      },
    },

    'push-dev': {
      description: 'Build and push controller Docker image to Fly registry',
      async run(args: string[], root: string): Promise<void> {
        const kiloclawDir = join(root, 'kiloclaw');
        const devVarsPath = join(kiloclawDir, '.dev.vars');

        // 1. Authenticate with Fly registry
        ui.header('Authenticating with Fly registry...');
        const authOk = await run({
          command: 'fly auth docker',
          cwd: root,
          label: 'fly auth docker',
        });
        if (!authOk) {
          ui.error('Failed to authenticate with Fly registry.');
          process.exit(1);
        }

        // 2. Read config from .dev.vars
        const devVarsFile = Bun.file(devVarsPath);
        if (!(await devVarsFile.exists())) {
          ui.error(".dev.vars not found. Run 'pnpm kilo kiloclaw setup' first.");
          process.exit(1);
        }
        let devVarsContent = await devVarsFile.text();
        const devVars = parseEnvFile(devVarsContent);

        const appName = devVars['FLY_APP_NAME'] || 'kiloclaw-dev';

        // 3. Parse --local flag
        const useLocal = args.includes('--local');

        // 4. Select Dockerfile
        let dockerfile: string;
        if (useLocal) {
          dockerfile = join(kiloclawDir, 'Dockerfile.local');
          // Validate tarball exists
          const proc = Bun.spawn(
            ['sh', '-c', `ls "${kiloclawDir}"/openclaw-build/openclaw-*.tgz 2>/dev/null`],
            { cwd: root, stdout: 'pipe', stderr: 'pipe' }
          );
          await proc.exited;
          const found = (await new Response(proc.stdout).text()).trim();
          if (!found) {
            ui.error('No openclaw-*.tgz found in openclaw-build/.');
            ui.error('Build your fork first:');
            ui.error('  cd /path/to/openclaw && pnpm build && npm pack');
            ui.error(`  cp openclaw-*.tgz ${kiloclawDir}/openclaw-build/`);
            process.exit(1);
          }
          ui.success('Using Dockerfile.local (local OpenClaw tarball)');
        } else {
          dockerfile = join(kiloclawDir, 'Dockerfile');
        }

        // 5. Generate timestamped tag
        const timestamp = (Date.now() / 1000) | 0;
        const tag = `dev-${timestamp}`;
        const image = `registry.fly.io/${appName}:${tag}`;

        // Get git SHA
        const gitProc = Bun.spawn(['git', '-C', kiloclawDir, 'rev-parse', 'HEAD'], {
          stdout: 'pipe',
          stderr: 'pipe',
        });
        await gitProc.exited;
        const gitSha = (await new Response(gitProc.stdout).text()).trim() || 'unknown';

        ui.header(`Building + pushing ${image} (linux/amd64)...`);
        console.log(`  Controller commit: ${gitSha}`);

        // 6. Docker buildx build
        const buildCmd = [
          'docker',
          'buildx',
          'build',
          '--platform',
          'linux/amd64',
          '-f',
          dockerfile,
          '--build-arg',
          `CONTROLLER_COMMIT=${gitSha}`,
          '--build-arg',
          `CONTROLLER_CACHE_BUST=${timestamp}`,
          '-t',
          image,
          '--push',
          kiloclawDir,
        ].join(' ');

        const buildOk = await run({
          command: buildCmd,
          cwd: root,
          label: `docker buildx build ... -t ${image} --push`,
        });
        if (!buildOk) {
          ui.error('Docker build failed.');
          process.exit(1);
        }

        // 7. Update FLY_IMAGE_TAG in .dev.vars
        devVarsContent = setDevVar(devVarsContent, 'FLY_IMAGE_TAG', tag);
        await Bun.write(devVarsPath, devVarsContent);

        ui.success(`Updated .dev.vars: FLY_IMAGE_TAG=${tag}`);
        console.log('');
        console.log(`  FLY_IMAGE_TAG=${tag}`);
        console.log('');
        ui.success('Done. Restart wrangler dev to pick up the new tag.');
        ui.success('Then restart your instance from the dashboard (or destroy + re-provision).');
      },
    },
  },
};
