import chalk from 'chalk';
import { login, isLoggedIn, logout, verifyLogin } from '../lib/auth.js';

export function registerLoginCommand(program) {
  program
    .command('login')
    .description('Log in to alphaXiv (opens browser)')
    .action(async () => {
      try {
        if (isLoggedIn()) {
          process.stderr.write(chalk.dim('Already logged in. Use `alpha logout` to sign out first.\n'));
        }
        const { userInfo } = await login();
        const name = userInfo?.name || userInfo?.email || 'unknown';
        console.log(chalk.green(`Logged in to alphaXiv as ${name}`));
      } catch (err) {
        process.stderr.write(`${chalk.red('Login failed:')} ${err.message}\n`);
        process.exit(1);
      }
    });
}

export function registerLogoutCommand(program) {
  program
    .command('logout')
    .description('Log out of alphaXiv')
    .action(() => {
      logout();
      console.log(chalk.green('Logged out'));
    });
}

export function registerStatusCommand(program) {
  program
    .command('status')
    .description('Show alphaXiv authentication status')
    .action(async () => {
      let status;
      try {
        status = await verifyLogin();
      } catch (err) {
        process.stderr.write(`${chalk.red('Could not verify alphaXiv login:')} ${err.message}\n`);
        process.exitCode = 1;
        return;
      }
      if (!status.loggedIn) {
        process.stderr.write(status.reason === 'expired'
          ? 'alphaXiv session expired. Run `alpha login` to sign in again.\n'
          : 'Not logged in to alphaXiv. Run `alpha login`.\n');
        process.exitCode = 1;
        return;
      }
      console.log(chalk.green(status.name ? `Logged in to alphaXiv as ${status.name}` : 'Logged in to alphaXiv'));
    });
}
