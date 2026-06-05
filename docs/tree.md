# mcp-ts-core - Directory Structure

Generated on: 2026-06-05 12:06:04

```text
mcp-ts-core/
├── .agents/
├── .claude/
├── .github/
│   ├── ISSUE_TEMPLATE/
│   │   ├── bug_report.yml
│   │   ├── config.yml
│   │   └── feature_request.yml
│   └── FUNDING.yml
├── .husky/
│   └── pre-commit
├── .vscode/
│   ├── extensions.json
│   └── settings.json
├── agent-feedback/
├── announcements/
├── changelog/
│   ├── 0.1.x/
│   ├── 0.2.x/
│   ├── 0.3.x/
│   ├── 0.4.x/
│   ├── 0.5.x/
│   ├── 0.6.x/
│   ├── 0.7.x/
│   ├── 0.8.x/
│   ├── 0.9.x/
│   └── template.md
├── docs/
│   ├── mcp-specification/
│   │   ├── 2025-06-18/
│   │   │   ├── best-practices/
│   │   │   │   └── security.md
│   │   │   ├── core/
│   │   │   │   ├── authorization.md
│   │   │   │   ├── lifecycle.md
│   │   │   │   ├── overview.md
│   │   │   │   └── transports.md
│   │   │   └── utils/
│   │   │       ├── cancellation.md
│   │   │       ├── completion.md
│   │   │       ├── logging.md
│   │   │       ├── pagination.md
│   │   │       ├── ping.md
│   │   │       └── progress.md
│   │   └── 2025-11-25/
│   │       ├── client/
│   │       │   ├── elicitation.md
│   │       │   ├── roots.md
│   │       │   └── sampling.md
│   │       ├── core/
│   │       │   ├── authorization.md
│   │       │   ├── lifecycle.md
│   │       │   ├── overview.md
│   │       │   └── transports.md
│   │       ├── extensions/
│   │       │   ├── apps-build.md
│   │       │   ├── apps-overview.md
│   │       │   ├── auth-enterprise-managed.md
│   │       │   ├── auth-oauth-client-credentials.md
│   │       │   ├── auth-overview.md
│   │       │   ├── client-matrix.md
│   │       │   └── overview.md
│   │       ├── server/
│   │       │   ├── overview.md
│   │       │   ├── prompts.md
│   │       │   ├── resources.md
│   │       │   ├── tools.md
│   │       │   └── utilities.md
│   │       ├── utils/
│   │       │   ├── cancellation.md
│   │       │   ├── ping.md
│   │       │   ├── progress.md
│   │       │   └── tasks.md
│   │       ├── architecture.md
│   │       ├── key-changes.md
│   │       ├── schema-reference.md
│   │       └── specification.md
│   └── telemetry/
│       ├── dashboards.md
│       ├── mcp-ts-core-dashboard.json
│       └── observability.md
├── examples/
│   ├── mcp-server/
│   │   ├── prompts/
│   │   │   └── definitions/
│   │   │       └── code-review.prompt.ts
│   │   ├── resources/
│   │   │   └── definitions/
│   │   │       ├── data-explorer-ui.app-resource.ts
│   │   │       └── echo.resource.ts
│   │   └── tools/
│   │       └── definitions/
│   │           ├── template-async-countdown.tool.ts
│   │           ├── template-cat-fact.tool.ts
│   │           ├── template-code-review-sampling.tool.ts
│   │           ├── template-data-explorer.app-tool.ts
│   │           ├── template-echo-message.tool.ts
│   │           ├── template-image-test.tool.ts
│   │           └── template-madlibs-elicitation.tool.ts
│   ├── index.ts
│   └── worker.ts
├── scripts/
│   ├── audit-open-index-signatures.ts
│   ├── build-changelog.ts
│   ├── build.ts
│   ├── check-docs-sync.ts
│   ├── check-framework-antipatterns.ts
│   ├── check-skill-versions.ts
│   ├── check-skills-sync.ts
│   ├── clean.ts
│   ├── devcheck.ts
│   ├── devdocs.ts
│   ├── fetch-openapi-spec.ts
│   ├── lint-mcp.ts
│   ├── lint-packaging.ts
│   ├── list-skills.ts
│   ├── release-github.ts
│   ├── split-changelog.ts
│   ├── tree.ts
│   └── update-coverage.ts
├── skills/
│   ├── add-app-tool/
│   │   └── SKILL.md
│   ├── add-export/
│   │   └── SKILL.md
│   ├── add-prompt/
│   │   └── SKILL.md
│   ├── add-provider/
│   │   └── SKILL.md
│   ├── add-resource/
│   │   └── SKILL.md
│   ├── add-service/
│   │   └── SKILL.md
│   ├── add-test/
│   │   └── SKILL.md
│   ├── add-tool/
│   │   └── SKILL.md
│   ├── api-auth/
│   │   └── SKILL.md
│   ├── api-canvas/
│   │   └── SKILL.md
│   ├── api-config/
│   │   └── SKILL.md
│   ├── api-context/
│   │   └── SKILL.md
│   ├── api-errors/
│   │   └── SKILL.md
│   ├── api-linter/
│   │   └── SKILL.md
│   ├── api-mirror/
│   │   └── SKILL.md
│   ├── api-services/
│   │   ├── references/
│   │   │   ├── graph.md
│   │   │   ├── llm.md
│   │   │   └── speech.md
│   │   └── SKILL.md
│   ├── api-telemetry/
│   │   └── SKILL.md
│   ├── api-testing/
│   │   └── SKILL.md
│   ├── api-utils/
│   │   ├── references/
│   │   │   ├── formatting.md
│   │   │   ├── parsing.md
│   │   │   └── security.md
│   │   └── SKILL.md
│   ├── api-workers/
│   │   └── SKILL.md
│   ├── code-simplifier/
│   │   └── SKILL.md
│   ├── design-mcp-server/
│   │   └── SKILL.md
│   ├── field-test/
│   │   └── SKILL.md
│   ├── git-wrapup/
│   │   └── SKILL.md
│   ├── maintenance/
│   │   └── SKILL.md
│   ├── orchestrations/
│   │   ├── workflows/
│   │   │   ├── field-test-fix.md
│   │   │   ├── fix-wrapup-release.md
│   │   │   ├── greenfield-build.md
│   │   │   └── maintenance-release.md
│   │   └── SKILL.md
│   ├── polish-docs-meta/
│   │   ├── references/
│   │   │   ├── agent-protocol.md
│   │   │   ├── package-meta.md
│   │   │   ├── readme.md
│   │   │   └── server-json.md
│   │   └── SKILL.md
│   ├── release-and-publish/
│   │   └── SKILL.md
│   ├── report-issue-framework/
│   │   └── SKILL.md
│   ├── report-issue-local/
│   │   └── SKILL.md
│   ├── security-pass/
│   │   └── SKILL.md
│   ├── setup/
│   │   └── SKILL.md
│   ├── techniques/
│   │   ├── references/
│   │   │   └── outline-on-overflow.md
│   │   └── SKILL.md
│   ├── tool-defs-analysis/
│   │   └── SKILL.md
│   └── README.md
├── src/
│   ├── cli/
│   │   └── init.ts
│   ├── config/
│   │   ├── index.ts
│   │   └── parseEnvConfig.ts
│   ├── core/
│   │   ├── app.ts
│   │   ├── context.ts
│   │   ├── gcPressure.ts
│   │   ├── index.ts
│   │   ├── serverManifest.ts
│   │   └── worker.ts
│   ├── linter/
│   │   ├── rules/
│   │   │   ├── enrichment-rules.ts
│   │   │   ├── error-contract-rules.ts
│   │   │   ├── format-parity-rules.ts
│   │   │   ├── handler-body-rules.ts
│   │   │   ├── index.ts
│   │   │   ├── landing-rules.ts
│   │   │   ├── name-rules.ts
│   │   │   ├── portability-rules.ts
│   │   │   ├── prompt-rules.ts
│   │   │   ├── resource-rules.ts
│   │   │   ├── schema-rules.ts
│   │   │   ├── server-json-rules.ts
│   │   │   ├── source-text.ts
│   │   │   └── tool-rules.ts
│   │   ├── index.ts
│   │   ├── types.ts
│   │   └── validate.ts
│   ├── mcp-server/
│   │   ├── apps/
│   │   │   └── appBuilders.ts
│   │   ├── prompts/
│   │   │   ├── utils/
│   │   │   │   └── promptDefinition.ts
│   │   │   └── prompt-registration.ts
│   │   ├── resources/
│   │   │   ├── utils/
│   │   │   │   ├── resourceDefinition.ts
│   │   │   │   └── resourceHandlerFactory.ts
│   │   │   └── resource-registration.ts
│   │   ├── roots/
│   │   │   └── roots-registration.ts
│   │   ├── tasks/
│   │   │   ├── core/
│   │   │   │   ├── sessionAwareTaskStore.ts
│   │   │   │   ├── storageBackedTaskStore.ts
│   │   │   │   ├── taskManager.ts
│   │   │   │   └── taskTypes.ts
│   │   │   └── utils/
│   │   │       └── taskToolDefinition.ts
│   │   ├── tools/
│   │   │   ├── utils/
│   │   │   │   ├── disabled-tool.ts
│   │   │   │   ├── toolDefinition.ts
│   │   │   │   └── toolHandlerFactory.ts
│   │   │   └── tool-registration.ts
│   │   ├── transports/
│   │   │   ├── auth/
│   │   │   │   ├── lib/
│   │   │   │   │   ├── authContext.ts
│   │   │   │   │   ├── authTypes.ts
│   │   │   │   │   ├── authUtils.ts
│   │   │   │   │   ├── checkScopes.ts
│   │   │   │   │   └── claimParser.ts
│   │   │   │   ├── strategies/
│   │   │   │   │   ├── authStrategy.ts
│   │   │   │   │   ├── jwtStrategy.ts
│   │   │   │   │   └── oauthStrategy.ts
│   │   │   │   ├── authFactory.ts
│   │   │   │   └── authMiddleware.ts
│   │   │   ├── http/
│   │   │   │   ├── landing-page/
│   │   │   │   │   ├── assets/
│   │   │   │   │   │   ├── copy-script.ts
│   │   │   │   │   │   └── styles.ts
│   │   │   │   │   ├── sections/
│   │   │   │   │   │   ├── connect.ts
│   │   │   │   │   │   ├── extensions.ts
│   │   │   │   │   │   ├── footer.ts
│   │   │   │   │   │   ├── head.ts
│   │   │   │   │   │   ├── hero.ts
│   │   │   │   │   │   ├── prompts.ts
│   │   │   │   │   │   ├── resources.ts
│   │   │   │   │   │   ├── status-strip.ts
│   │   │   │   │   │   └── tools.ts
│   │   │   │   │   ├── handler.ts
│   │   │   │   │   ├── index.ts
│   │   │   │   │   ├── primitives.ts
│   │   │   │   │   └── render.ts
│   │   │   │   ├── httpErrorHandler.ts
│   │   │   │   ├── httpServer.ts
│   │   │   │   ├── httpTransport.ts
│   │   │   │   ├── httpTypes.ts
│   │   │   │   ├── protectedResourceMetadata.ts
│   │   │   │   ├── robotsTxt.ts
│   │   │   │   ├── serverCard.ts
│   │   │   │   ├── sessionIdUtils.ts
│   │   │   │   └── sessionStore.ts
│   │   │   ├── stdio/
│   │   │   │   └── stdioTransport.ts
│   │   │   ├── heartbeat.ts
│   │   │   ├── ITransport.ts
│   │   │   └── manager.ts
│   │   ├── notifications.ts
│   │   └── server.ts
│   ├── services/
│   │   ├── canvas/
│   │   │   ├── core/
│   │   │   │   ├── canvasFactory.ts
│   │   │   │   ├── CanvasInstance.ts
│   │   │   │   ├── CanvasRegistry.ts
│   │   │   │   ├── DataCanvas.ts
│   │   │   │   ├── IDataCanvasProvider.ts
│   │   │   │   ├── schemaSniffer.ts
│   │   │   │   └── sqlGate.ts
│   │   │   ├── providers/
│   │   │   │   └── duckdb/
│   │   │   │       ├── DuckdbProvider.ts
│   │   │   │       └── exportWriter.ts
│   │   │   ├── index.ts
│   │   │   ├── spillover.ts
│   │   │   └── types.ts
│   │   ├── graph/
│   │   │   ├── core/
│   │   │   │   ├── GraphService.ts
│   │   │   │   └── IGraphProvider.ts
│   │   │   ├── providers/
│   │   │   └── types.ts
│   │   ├── llm/
│   │   │   ├── core/
│   │   │   │   └── ILlmProvider.ts
│   │   │   ├── providers/
│   │   │   │   └── openrouter.provider.ts
│   │   │   └── types.ts
│   │   ├── mirror/
│   │   │   ├── core/
│   │   │   │   ├── defineMirror.ts
│   │   │   │   └── runner.ts
│   │   │   ├── sqlite/
│   │   │   │   ├── handle.ts
│   │   │   │   ├── schema.ts
│   │   │   │   └── sqliteMirrorStore.ts
│   │   │   ├── index.ts
│   │   │   └── types.ts
│   │   ├── speech/
│   │   │   ├── core/
│   │   │   │   ├── ISpeechProvider.ts
│   │   │   │   ├── speechMetrics.ts
│   │   │   │   └── SpeechService.ts
│   │   │   ├── providers/
│   │   │   │   ├── elevenlabs.provider.ts
│   │   │   │   └── whisper.provider.ts
│   │   │   └── types.ts
│   │   └── index.ts
│   ├── storage/
│   │   ├── core/
│   │   │   ├── IStorageProvider.ts
│   │   │   ├── storageFactory.ts
│   │   │   ├── StorageService.ts
│   │   │   └── storageValidation.ts
│   │   └── providers/
│   │       ├── cloudflare/
│   │       │   ├── d1Provider.ts
│   │       │   ├── kvProvider.ts
│   │       │   └── r2Provider.ts
│   │       ├── fileSystem/
│   │       │   └── fileSystemProvider.ts
│   │       ├── inMemory/
│   │       │   └── inMemoryProvider.ts
│   │       └── supabase/
│   │           ├── supabase.types.ts
│   │           └── supabaseProvider.ts
│   ├── testing/
│   │   ├── fuzz.ts
│   │   └── index.ts
│   ├── types-global/
│   │   └── errors.ts
│   ├── utils/
│   │   ├── formatting/
│   │   │   ├── diffFormatter.ts
│   │   │   ├── html.ts
│   │   │   ├── index.ts
│   │   │   ├── markdownBuilder.ts
│   │   │   ├── partialResult.ts
│   │   │   ├── tableFormatter.ts
│   │   │   └── treeFormatter.ts
│   │   ├── internal/
│   │   │   ├── error-handler/
│   │   │   │   ├── errorHandler.ts
│   │   │   │   ├── helpers.ts
│   │   │   │   ├── mappings.ts
│   │   │   │   └── types.ts
│   │   │   ├── encoding.ts
│   │   │   ├── health.ts
│   │   │   ├── lazyImport.ts
│   │   │   ├── logger.ts
│   │   │   ├── performance.ts
│   │   │   ├── requestContext.ts
│   │   │   ├── runtime.ts
│   │   │   └── startupBanner.ts
│   │   ├── metrics/
│   │   │   └── tokenCounter.ts
│   │   ├── network/
│   │   │   ├── fetchWithTimeout.ts
│   │   │   ├── httpError.ts
│   │   │   └── retry.ts
│   │   ├── overflow/
│   │   │   └── outlineOnOverflow.ts
│   │   ├── pagination/
│   │   │   └── pagination.ts
│   │   ├── parsing/
│   │   │   ├── csvParser.ts
│   │   │   ├── dateParser.ts
│   │   │   ├── frontmatterParser.ts
│   │   │   ├── htmlExtractor.ts
│   │   │   ├── index.ts
│   │   │   ├── jsonParser.ts
│   │   │   ├── pdfParser.ts
│   │   │   ├── thinkBlock.ts
│   │   │   ├── xmlParser.ts
│   │   │   └── yamlParser.ts
│   │   ├── scheduling/
│   │   │   └── scheduler.ts
│   │   ├── security/
│   │   │   ├── idGenerator.ts
│   │   │   ├── index.ts
│   │   │   ├── rateLimiter.ts
│   │   │   └── sanitization.ts
│   │   ├── telemetry/
│   │   │   ├── attributes.ts
│   │   │   ├── index.ts
│   │   │   ├── instrumentation.ts
│   │   │   ├── metrics.ts
│   │   │   └── trace.ts
│   │   ├── types/
│   │   │   ├── guards.ts
│   │   │   └── index.ts
│   │   └── index.ts
│   └── index.ts
├── templates/
│   ├── .claude-plugin/
│   │   └── plugin.json
│   ├── .codex-plugin/
│   │   ├── mcp.json
│   │   └── plugin.json
│   ├── .github/
│   │   └── ISSUE_TEMPLATE/
│   │       ├── bug_report.yml
│   │       ├── config.yml
│   │       └── feature_request.yml
│   ├── .vscode/
│   │   ├── extensions.json
│   │   └── settings.json
│   ├── changelog/
│   │   └── template.md
│   ├── src/
│   │   ├── mcp-server/
│   │   │   ├── prompts/
│   │   │   │   └── definitions/
│   │   │   │       └── echo.prompt.ts
│   │   │   ├── resources/
│   │   │   │   └── definitions/
│   │   │   │       ├── echo-app-ui.app-resource.ts
│   │   │   │       └── echo.resource.ts
│   │   │   └── tools/
│   │   │       └── definitions/
│   │   │           ├── echo-app.app-tool.ts
│   │   │           └── echo.tool.ts
│   │   └── index.ts
│   ├── tests/
│   │   ├── prompts/
│   │   │   └── echo.prompt.test.ts
│   │   ├── resources/
│   │   │   └── echo.resource.test.ts
│   │   └── tools/
│   │       └── echo.tool.test.ts
│   ├── _.dockerignore
│   ├── _.gitignore
│   ├── _.mcpbignore
│   ├── _tsconfig.build.json
│   ├── _tsconfig.json
│   ├── .env.example
│   ├── AGENTS.md
│   ├── biome.template.json
│   ├── CLAUDE.md
│   ├── devcheck.config.json
│   ├── Dockerfile
│   ├── manifest.json
│   ├── package.json
│   ├── server.json
│   └── vitest.config.ts
├── tests/
│   ├── compliance/
│   │   └── storage-provider.test.ts
│   ├── fixtures/
│   │   ├── auth-scoped-server.js
│   │   └── worker-runtime.fixture.ts
│   ├── fuzz/
│   │   ├── definition-fuzz.test.ts
│   │   ├── error-handler.fuzz.test.ts
│   │   └── tool-handler-pipeline.fuzz.test.ts
│   ├── helpers/
│   │   ├── context-helpers.ts
│   │   ├── default-server-mcp.ts
│   │   ├── fixtures.ts
│   │   ├── http-helpers.ts
│   │   ├── index.ts
│   │   ├── matchers.ts
│   │   └── server-process.ts
│   ├── integration/
│   │   ├── config.int.test.ts
│   │   ├── error-handler.int.test.ts
│   │   ├── http-auth-sessions.test.ts
│   │   ├── http-auth.test.ts
│   │   ├── http-authz.e2e.test.ts
│   │   ├── http-sessions.test.ts
│   │   ├── http-sse-abort.int.test.ts
│   │   ├── http-transport.int.test.ts
│   │   ├── http.test.ts
│   │   ├── logger.int.test.ts
│   │   ├── mcp-apps.int.test.ts
│   │   ├── package-consumer.int.test.ts
│   │   └── stdio.test.ts
│   ├── smoke/
│   │   ├── prompts/
│   │   │   └── code-review.prompt.test.ts
│   │   ├── resources/
│   │   │   ├── echo-app-ui.app-resource.test.ts
│   │   │   └── echo.resource.test.ts
│   │   ├── tools/
│   │   │   ├── template-async-countdown.tool.test.ts
│   │   │   ├── template-code-review-sampling.tool.test.ts
│   │   │   ├── template-data-explorer.app-tool.test.ts
│   │   │   ├── template-echo-app.app-tool.test.ts
│   │   │   ├── template-echo-message.tool.test.ts
│   │   │   └── template-madlibs-elicitation.tool.test.ts
│   │   └── canvas-duckdb.test.ts
│   ├── unit/
│   │   ├── cli/
│   │   │   └── init.test.ts
│   │   ├── config/
│   │   │   ├── index.test.ts
│   │   │   └── parseEnvConfig.test.ts
│   │   ├── core/
│   │   │   ├── app.test.ts
│   │   │   ├── gcPressure.test.ts
│   │   │   ├── serverManifest.test.ts
│   │   │   └── typed-fail.test.ts
│   │   ├── helpers/
│   │   │   └── matchers.test.ts
│   │   ├── linter/
│   │   │   ├── enrichment-rules.test.ts
│   │   │   ├── error-contract-rules.test.ts
│   │   │   ├── format-parity-rules.test.ts
│   │   │   ├── handler-body-rules.test.ts
│   │   │   ├── landing-rules.test.ts
│   │   │   ├── portability-rules.test.ts
│   │   │   ├── resource-rules.test.ts
│   │   │   ├── server-json-rules.test.ts
│   │   │   ├── source-text.test.ts
│   │   │   ├── tool-rules.test.ts
│   │   │   └── validate.test.ts
│   │   ├── mcp-server/
│   │   │   ├── apps/
│   │   │   │   └── appBuilders.test.ts
│   │   │   ├── prompts/
│   │   │   │   ├── utils/
│   │   │   │   │   └── promptDefinition.test.ts
│   │   │   │   └── prompt-registration.test.ts
│   │   │   ├── resources/
│   │   │   │   ├── utils/
│   │   │   │   │   ├── resourceDefinition.test.ts
│   │   │   │   │   └── resourceHandlerFactory.test.ts
│   │   │   │   └── resource-registration.test.ts
│   │   │   ├── roots/
│   │   │   │   └── roots-registration.test.ts
│   │   │   ├── tasks/
│   │   │   │   ├── core/
│   │   │   │   │   ├── sessionAwareTaskStore.test.ts
│   │   │   │   │   ├── storageBackedTaskStore.test.ts
│   │   │   │   │   └── taskManager.test.ts
│   │   │   │   ├── utils/
│   │   │   │   │   └── taskToolDefinition.test.ts
│   │   │   │   └── taskManager.metrics.test.ts
│   │   │   ├── tools/
│   │   │   │   ├── utils/
│   │   │   │   │   ├── toolDefinition.test.ts
│   │   │   │   │   └── toolHandlerFactory.test.ts
│   │   │   │   ├── disabled-tool.test.ts
│   │   │   │   ├── enrichment.test.ts
│   │   │   │   ├── tool-registration.lifecycle.test.ts
│   │   │   │   ├── tool-registration.test.ts
│   │   │   │   └── typed-error-contract.test.ts
│   │   │   ├── transports/
│   │   │   │   ├── auth/
│   │   │   │   │   ├── lib/
│   │   │   │   │   │   ├── authContext.test.ts
│   │   │   │   │   │   ├── authTypes.test.ts
│   │   │   │   │   │   ├── authUtils.test.ts
│   │   │   │   │   │   ├── checkScopes.test.ts
│   │   │   │   │   │   └── claimParser.test.ts
│   │   │   │   │   ├── strategies/
│   │   │   │   │   │   ├── authStrategy.test.ts
│   │   │   │   │   │   ├── jwtStrategy.mocked.test.ts
│   │   │   │   │   │   ├── jwtStrategy.test.ts
│   │   │   │   │   │   └── oauthStrategy.test.ts
│   │   │   │   │   ├── authFactory.test.ts
│   │   │   │   │   ├── authMiddleware.metrics.test.ts
│   │   │   │   │   └── authMiddleware.test.ts
│   │   │   │   ├── http/
│   │   │   │   │   ├── httpErrorHandler.test.ts
│   │   │   │   │   ├── httpTransport.lifecycle.test.ts
│   │   │   │   │   ├── httpTransport.test.ts
│   │   │   │   │   ├── httpTypes.test.ts
│   │   │   │   │   ├── landing-page.test.ts
│   │   │   │   │   ├── protectedResourceMetadata.test.ts
│   │   │   │   │   ├── robotsTxt.test.ts
│   │   │   │   │   ├── serverCard.test.ts
│   │   │   │   │   ├── sessionIdUtils.runtime.test.ts
│   │   │   │   │   ├── sessionIdUtils.test.ts
│   │   │   │   │   ├── sessionStore.metrics.test.ts
│   │   │   │   │   └── sessionStore.test.ts
│   │   │   │   ├── stdio/
│   │   │   │   │   └── stdioTransport.test.ts
│   │   │   │   ├── heartbeat.test.ts
│   │   │   │   ├── ITransport.test.ts
│   │   │   │   └── manager.test.ts
│   │   │   └── server.test.ts
│   │   ├── packaging/
│   │   │   ├── export-map.test.ts
│   │   │   └── optional-peer-deps.test.ts
│   │   ├── public-api/
│   │   │   └── type-contract.test.ts
│   │   ├── scripts/
│   │   │   └── devdocs.test.ts
│   │   ├── services/
│   │   │   ├── canvas/
│   │   │   │   ├── appendValueCoerce.test.ts
│   │   │   │   ├── canvasFactory.test.ts
│   │   │   │   ├── CanvasRegistry.test.ts
│   │   │   │   ├── classifyDuckdbError.test.ts
│   │   │   │   ├── DataCanvas.test.ts
│   │   │   │   ├── exportWriter.test.ts
│   │   │   │   ├── schemaSniffer.test.ts
│   │   │   │   ├── spillover.test.ts
│   │   │   │   ├── sqlGate.test.ts
│   │   │   │   └── toBigInt.test.ts
│   │   │   ├── graph/
│   │   │   │   ├── core/
│   │   │   │   │   ├── GraphService.metrics.test.ts
│   │   │   │   │   └── GraphService.test.ts
│   │   │   │   └── types.test.ts
│   │   │   ├── llm/
│   │   │   │   ├── core/
│   │   │   │   ├── providers/
│   │   │   │   │   ├── openrouter.provider.metrics.test.ts
│   │   │   │   │   ├── openrouter.provider.test.ts
│   │   │   │   │   └── openrouter.provider.test.ts.disabled
│   │   │   │   └── types.test.ts
│   │   │   ├── mirror/
│   │   │   │   ├── runner.test.ts
│   │   │   │   ├── schema.test.ts
│   │   │   │   └── sqliteMirrorStore.test.ts
│   │   │   └── speech/
│   │   │       ├── core/
│   │   │       │   ├── ISpeechProvider.test.ts
│   │   │       │   ├── speechMetrics.test.ts
│   │   │       │   └── SpeechService.test.ts
│   │   │       ├── providers/
│   │   │       │   ├── elevenlabs.provider.test.ts
│   │   │       │   └── whisper.provider.test.ts
│   │   │       └── types.test.ts
│   │   ├── storage/
│   │   │   ├── core/
│   │   │   │   ├── IStorageProvider.test.ts
│   │   │   │   ├── storageFactory.test.ts
│   │   │   │   └── storageValidation.test.ts
│   │   │   ├── providers/
│   │   │   │   ├── cloudflare/
│   │   │   │   │   ├── d1Provider.test.ts
│   │   │   │   │   ├── kvProvider.test.ts
│   │   │   │   │   └── r2Provider.test.ts
│   │   │   │   ├── fileSystem/
│   │   │   │   │   └── fileSystemProvider.test.ts
│   │   │   │   ├── inMemory/
│   │   │   │   │   └── inMemoryProvider.test.ts
│   │   │   │   └── supabase/
│   │   │   │       ├── supabase.types.test.ts
│   │   │   │       └── supabaseProvider.test.ts
│   │   │   ├── StorageService.metrics.test.ts
│   │   │   └── StorageService.test.ts
│   │   ├── testing/
│   │   │   ├── exports.test.ts
│   │   │   ├── mockContext.test.ts
│   │   │   └── mockContextFidelity.test.ts
│   │   ├── types-global/
│   │   │   └── errors.test.ts
│   │   ├── utils/
│   │   │   ├── formatting/
│   │   │   │   ├── diffFormatter.test.ts
│   │   │   │   ├── html.test.ts
│   │   │   │   ├── markdownBuilder.test.ts
│   │   │   │   ├── partialResult.test.ts
│   │   │   │   ├── tableFormatter.test.ts
│   │   │   │   └── treeFormatter.test.ts
│   │   │   ├── internal/
│   │   │   │   ├── error-handler/
│   │   │   │   │   ├── errorHandler.test.ts
│   │   │   │   │   ├── helpers.test.ts
│   │   │   │   │   ├── mappings.test.ts
│   │   │   │   │   └── types.test.ts
│   │   │   │   ├── encoding.test.ts
│   │   │   │   ├── errorHandler.metrics.test.ts
│   │   │   │   ├── errorHandler.unit.test.ts
│   │   │   │   ├── health.test.ts
│   │   │   │   ├── lazyImport.test.ts
│   │   │   │   ├── logger.test.ts
│   │   │   │   ├── performance.init.test.ts
│   │   │   │   ├── performance.test.ts
│   │   │   │   ├── requestContext.test.ts
│   │   │   │   ├── runtime.test.ts
│   │   │   │   └── startupBanner.test.ts
│   │   │   ├── metrics/
│   │   │   │   └── tokenCounter.test.ts
│   │   │   ├── network/
│   │   │   │   ├── fetchWithTimeout.metrics.test.ts
│   │   │   │   ├── fetchWithTimeout.test.ts
│   │   │   │   ├── httpError.test.ts
│   │   │   │   └── retry.test.ts
│   │   │   ├── overflow/
│   │   │   │   └── outlineOnOverflow.test.ts
│   │   │   ├── pagination/
│   │   │   │   └── index.test.ts
│   │   │   ├── parsing/
│   │   │   │   ├── csvParser.test.ts
│   │   │   │   ├── dateParser.test.ts
│   │   │   │   ├── frontmatterParser.test.ts
│   │   │   │   ├── htmlExtractor.test.ts
│   │   │   │   ├── jsonParser.test.ts
│   │   │   │   ├── pdfParser.test.ts
│   │   │   │   ├── xmlParser.test.ts
│   │   │   │   └── yamlParser.test.ts
│   │   │   ├── scheduling/
│   │   │   │   └── scheduler.test.ts
│   │   │   ├── security/
│   │   │   │   ├── idGenerator.test.ts
│   │   │   │   ├── rateLimiter.metrics.test.ts
│   │   │   │   ├── rateLimiter.test.ts
│   │   │   │   ├── sanitization.property.test.ts
│   │   │   │   └── sanitization.test.ts
│   │   │   ├── telemetry/
│   │   │   │   ├── attributes.test.ts
│   │   │   │   ├── index.test.ts
│   │   │   │   ├── instrumentation.lifecycle.test.ts
│   │   │   │   ├── instrumentation.test.ts
│   │   │   │   ├── metrics.test.ts
│   │   │   │   └── trace.test.ts
│   │   │   └── types/
│   │   │       └── guards.test.ts
│   │   ├── context.test.ts
│   │   └── worker.test.ts
│   ├── worker/
│   │   └── create-worker-handler.worker.test.ts
│   └── setup.ts
├── .dockerignore
├── .env.example
├── .gitattributes
├── .gitignore
├── .markdownlint.jsonc
├── .mcpbignore
├── AGENTS.md
├── biome.json
├── bun.lock
├── bunfig.toml
├── CHANGELOG.md
├── CITATION.cff
├── CLAUDE.md
├── devcheck.config.json
├── Dockerfile
├── LICENSE
├── package.json
├── README.md
├── repomix.config.json
├── server.json
├── smithery.yaml
├── tsconfig.base.json
├── tsconfig.build.json
├── tsconfig.json
├── tsconfig.scripts.json
├── tsconfig.test.json
├── tsdoc.json
├── typedoc.json
├── vitest.config.base.mjs
├── vitest.config.ts
├── vitest.integration.ts
├── vitest.worker.ts
└── wrangler.toml
```

_Note: This tree excludes files and directories matched by .gitignore and default patterns._
