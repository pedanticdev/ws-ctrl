import { access, mkdir } from 'node:fs/promises';
import { vol } from 'memfs';
import { temporaryDirectory } from 'tempy';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CONFIG, initConfig } from '../../../config.js';
import { UseCaseStep } from '../../../types/index.js';
import { Logger, TestBed, execCommand } from '../../../utils/index.js';
import { TemplatesAccess } from '../../access/templates-access.js';
import { ScriptExecutor } from '../../script-executor.js';
import { GenerateServiceConfiguration } from './generate-service-configuration.js';

vi.mock('node:fs');
vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual('node:fs/promises') as any;
  return {
    ...actual,
    mkdir: vi.fn(),
    access: vi.fn(),
  };
});
vi.mock('../../../utils/processes.js', () => ({
  execCommand: vi.fn(),
}));

const path = temporaryDirectory();

describe('GenerateServiceConfiguration', () => {
  let executor: GenerateServiceConfiguration;
  let mockExecCommand: any;
  let mockAccess: any;
  let mockMkdir: any;

  beforeEach(() => {
    // Mock the file system
    vol.reset();
    vol.fromJSON({
      [`${path}/services.env`]: 'kcVersion=latest\nauthServerUrl=https://test.com/auth\nauthUser=admin\nauthPassword=password\nauthTenant=default',
    });

    const config = initConfig(path, 'test-org', null).store;

    TestBed.configureTestingModule({
      providers: [
        {
          provide: CONFIG,
          useFactory: () => config,
        },
        TemplatesAccess,
        ScriptExecutor,
        Logger,
      ],
    });

    executor = new GenerateServiceConfiguration(
      TestBed.inject(ScriptExecutor),
      TestBed.inject(TemplatesAccess)
    );

    mockExecCommand = vi.mocked(execCommand);
    mockExecCommand.mockResolvedValue(undefined);
    
    mockAccess = vi.mocked(access);
    mockMkdir = vi.mocked(mkdir);
  });

  afterEach(() => {
    vi.clearAllMocks();
    vol.reset();
  });

  it('should generate Docker command with correct mount syntax', async () => {
    const step: UseCaseStep = {
      type: 'EXECUTOR',
      executor: 'generate-service-configuration',
      context: {},
    };

    const context = {
      kcVersion: 'latest',
      authServerUrl: 'https://test.com/auth',
      authUser: 'admin',
      authPassword: 'password',
      authTenant: 'default',
    };

    await executor.execute(step, context);

    expect(mockExecCommand).toHaveBeenCalledOnce();

    const [dockerCommand, workspacePath] = mockExecCommand.mock.calls[0];

    expect(dockerCommand).toContain('--mount type=bind,src="');
    expect(dockerCommand).toContain('config/secret-templates",target="/secret-templates",readonly');
    expect(dockerCommand).toContain('config/services-config",target="/output"');

    // Test that user flag is not present (container runs as default user)
    expect(dockerCommand).not.toContain('--user');

    expect(dockerCommand).toContain('-c /secret-templates');
    expect(dockerCommand).toContain('-o /output');
    expect(dockerCommand).not.toContain('//secret-templates');
    expect(dockerCommand).not.toContain('//output');

    expect(workspacePath).toBe(path);
  });

  it('should handle special characters in password', async () => {
    // Override services.env with special character password
    vol.fromJSON({
      [`${path}/services.env`]: 'kcVersion=latest\nauthServerUrl=https://test.com/auth\nauthUser=admin\nauthPassword=pass^word$with&special\nauthTenant=default',
    });

    const step: UseCaseStep = {
      type: 'EXECUTOR',
      executor: 'generate-service-configuration',
      context: {},
    };

    const context = {};

    await executor.execute(step, context);

    const [dockerCommand] = mockExecCommand.mock.calls[0];

    // Password should be wrapped in quotes to handle special characters
    expect(dockerCommand).toContain('-p "pass^word$with&special"');
  });

  it('should use values from services.env file', async () => {
    vol.fromJSON({
      [`${path}/services.env`]: 'kcVersion=3.0.0\nauthServerUrl=https://prod.com/auth\nauthUser=prodadmin\nauthPassword=prodpass\nauthTenant=production',
    });

    const step: UseCaseStep = {
      type: 'EXECUTOR',
      executor: 'generate-service-configuration',
      context: {},
    };

    await executor.execute(step, {});

    const [dockerCommand] = mockExecCommand.mock.calls[0];

    expect(dockerCommand).toContain('ghcr.io/cycrilabs/keycloak-configurator:3.0.0');
    expect(dockerCommand).toContain('-s https://prod.com/auth');
    expect(dockerCommand).toContain('-u prodadmin');
    expect(dockerCommand).toContain('-p "prodpass"');
    expect(dockerCommand).toContain('-r production');
  });

  it('should override env values with context values', async () => {
    const step: UseCaseStep = {
      type: 'EXECUTOR',
      executor: 'generate-service-configuration',
      context: {
        authPassword: '"override_password"',
      },
    };

    const context = {
      kcVersion: 'latest',
      authServerUrl: 'https://test.com/auth',
      authUser: 'admin',
      authTenant: 'default',
    };

    await executor.execute(step, context);

    const [dockerCommand] = mockExecCommand.mock.calls[0];

    expect(dockerCommand).toContain('-p "override_password"');
  });

  it('should include --env-file when .env exists', async () => {
    // Mock that .env file exists
    mockAccess.mockResolvedValue(undefined);

    const step: UseCaseStep = {
      type: 'EXECUTOR',
      executor: 'generate-service-configuration',
      context: {},
    };

    await executor.execute(step, {});

    const [dockerCommand] = mockExecCommand.mock.calls[0];
    expect(dockerCommand).toContain(`--env-file ${path}/.env`);
  });

  it('should skip --env-file when .env does not exist', async () => {
    // Mock that .env file does not exist
    mockAccess.mockRejectedValue(new Error('ENOENT'));

    const step: UseCaseStep = {
      type: 'EXECUTOR',
      executor: 'generate-service-configuration',
      context: {},
    };

    await executor.execute(step, {});

    const [dockerCommand] = mockExecCommand.mock.calls[0];
    expect(dockerCommand).not.toContain('--env-file');
  });
});
