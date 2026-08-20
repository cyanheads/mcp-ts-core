# mcp-ts-core - Directory Structure

Generated on: 2026-08-20 18:02:27

```text
mcp-ts-core/
├── .github/
│   ├── ISSUE_TEMPLATE/
│   │   ├── bug_report.yml
│   │   ├── config.yml
│   │   └── feature_request.yml
│   ├── CODE_OF_CONDUCT.md
│   ├── CONTRIBUTING.md
│   ├── FUNDING.yml
│   └── SECURITY.md
├── .husky/
│   └── pre-commit
├── .vscode/
│   ├── extensions.json
│   └── settings.json
├── changelog/
│   ├── 0.1.x/
│   ├── 0.10.x/
│   ├── 0.11.x/
│   ├── 0.12.x/
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
│   │   ├── 2025-11-25/
│   │   │   ├── client/
│   │   │   │   ├── elicitation.md
│   │   │   │   ├── roots.md
│   │   │   │   └── sampling.md
│   │   │   ├── core/
│   │   │   │   ├── authorization.md
│   │   │   │   ├── lifecycle.md
│   │   │   │   ├── overview.md
│   │   │   │   └── transports.md
│   │   │   ├── extensions/
│   │   │   │   ├── apps-build.md
│   │   │   │   ├── apps-overview.md
│   │   │   │   ├── auth-enterprise-managed.md
│   │   │   │   ├── auth-oauth-client-credentials.md
│   │   │   │   ├── auth-overview.md
│   │   │   │   ├── client-matrix.md
│   │   │   │   └── overview.md
│   │   │   ├── server/
│   │   │   │   ├── overview.md
│   │   │   │   ├── prompts.md
│   │   │   │   ├── resources.md
│   │   │   │   ├── tools.md
│   │   │   │   └── utilities.md
│   │   │   ├── utils/
│   │   │   │   ├── cancellation.md
│   │   │   │   ├── ping.md
│   │   │   │   ├── progress.md
│   │   │   │   └── tasks.md
│   │   │   ├── architecture.md
│   │   │   ├── key-changes.md
│   │   │   ├── schema-reference.md
│   │   │   └── specification.md
│   │   └── 2026-07-28/
│   │       ├── architecture/
│   │       │   └── index.md
│   │       ├── basic/
│   │       │   ├── authorization/
│   │       │   │   ├── authorization-server-discovery.md
│   │       │   │   ├── client-registration.md
│   │       │   │   ├── index.md
│   │       │   │   └── security-considerations.md
│   │       │   ├── patterns/
│   │       │   │   ├── cancellation.md
│   │       │   │   ├── index.md
│   │       │   │   ├── mrtr.md
│   │       │   │   ├── progress.md
│   │       │   │   └── subscriptions.md
│   │       │   ├── transports/
│   │       │   │   ├── index.md
│   │       │   │   ├── stdio.md
│   │       │   │   └── streamable-http.md
│   │       │   ├── index.md
│   │       │   └── versioning.md
│   │       ├── client/
│   │       │   ├── elicitation.md
│   │       │   ├── roots.md
│   │       │   └── sampling.md
│   │       ├── server/
│   │       │   ├── utilities/
│   │       │   │   ├── caching.md
│   │       │   │   ├── completion.md
│   │       │   │   ├── logging.md
│   │       │   │   └── pagination.md
│   │       │   ├── discover.md
│   │       │   ├── index.md
│   │       │   ├── prompts.md
│   │       │   ├── resource-picker.png
│   │       │   ├── resources.md
│   │       │   ├── slash-command.png
│   │       │   └── tools.md
│   │       ├── changelog.md
│   │       ├── deprecated.md
│   │       ├── index.md
│   │       └── schema.md
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
│   │           ├── template-cat-fact.tool.ts
│   │           ├── template-data-explorer.app-tool.ts
│   │           ├── template-echo-message.tool.ts
│   │           ├── template-image-test.tool.ts
│   │           └── template-madlibs-elicitation.tool.ts
│   ├── duckdb-stub.ts
│   ├── index.ts
│   └── worker.ts
├── scripts/
│   ├── audit-open-index-signatures.ts
│   ├── build-changelog.ts
│   ├── build-inputs.ts
│   ├── build.ts
│   ├── check-dependency-specifiers.ts
│   ├── check-docs-sync.ts
│   ├── check-framework-antipatterns.ts
│   ├── check-skill-versions.ts
│   ├── check-skills-sync.ts
│   ├── clean-mcpb.ts
│   ├── clean.ts
│   ├── devcheck.ts
│   ├── devdocs.ts
│   ├── fetch-openapi-spec.ts
│   ├── lint-mcp.ts
│   ├── lint-packaging.ts
│   ├── list-skills.ts
│   ├── public-api-contract-update.ts
│   ├── public-api-contract.ts
│   ├── release-github.ts
│   ├── split-changelog.ts
│   ├── tree.ts
│   ├── update-coverage.ts
│   └── verify-package.ts
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
│   │   ├── logLevelAlias.ts
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
│   │   │   ├── definition-rules.ts
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
│   │   │   ├── resource-registration.ts
│   │   │   └── resourceSubscriptions.ts
│   │   ├── tools/
│   │   │   ├── utils/
│   │   │   │   ├── disabled-tool.ts
│   │   │   │   ├── schemaShape.ts
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
│   │   │   │   ├── eventStore.ts
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
│   │   ├── inputRequired.ts
│   │   ├── notifications.ts
│   │   ├── server.ts
│   │   └── types.ts
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
│   │   ├── index.ts
│   │   └── vitest.ts
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
│   │   │   ├── startupBanner.ts
│   │   │   └── telemetryMessages.ts
│   │   ├── metrics/
│   │   │   └── tokenCounter.ts
│   │   ├── network/
│   │   │   ├── fetchWithTimeout.ts
│   │   │   ├── httpError.ts
│   │   │   ├── responseBody.ts
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
│   │   │   ├── inputBudget.ts
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
│   │   ├── ISSUE_TEMPLATE/
│   │   │   ├── bug_report.yml
│   │   │   ├── config.yml
│   │   │   └── feature_request.yml
│   │   ├── CODE_OF_CONDUCT.md
│   │   ├── CONTRIBUTING.md
│   │   └── SECURITY.md
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
│   │   ├── fuzz/
│   │   │   └── echo-tool.fuzz.test.ts
│   │   ├── integration/
│   │   │   └── echo-contract.int.test.ts
│   │   ├── prompts/
│   │   │   └── echo.prompt.test.ts
│   │   ├── resources/
│   │   │   └── echo.resource.test.ts
│   │   ├── smoke/
│   │   │   └── definitions.smoke.test.ts
│   │   └── tools/
│   │       └── echo.tool.test.ts
│   ├── _.dockerignore
│   ├── _.gitattributes
│   ├── _.gitignore
│   ├── _.mcpbignore
│   ├── _tsconfig.build.json
│   ├── _tsconfig.json
│   ├── .env.example
│   ├── AGENTS.md
│   ├── biome.template.json
│   ├── bunfig.toml
│   ├── CLAUDE.md
│   ├── devcheck.config.json
│   ├── Dockerfile
│   ├── LICENSE
│   ├── manifest.json
│   ├── package.json
│   ├── server.json
│   └── vitest.config.ts
├── tests/
│   ├── compliance/
│   │   ├── storage-provider.test.ts
│   │   └── storage-provider.ts
│   ├── fixtures/
│   │   ├── auth-scoped-server.js
│   │   ├── http-protocol-session-server.js
│   │   ├── mcp-app-server.js
│   │   └── worker-runtime.fixture.ts
│   ├── fuzz/
│   │   ├── definition-fuzz.test.ts
│   │   ├── error-handler.fuzz.test.ts
│   │   ├── resource-handler-pipeline.fuzz.test.ts
│   │   ├── session-store.fuzz.test.ts
│   │   ├── session-store.model.fuzz.test.ts
│   │   └── tool-handler-pipeline.fuzz.test.ts
│   ├── helpers/
│   │   ├── context-helpers.ts
│   │   ├── default-server-mcp.ts
│   │   ├── fixtures.ts
│   │   ├── http-helpers.ts
│   │   ├── index.ts
│   │   ├── matchers.ts
│   │   ├── oauth-jwks-fixture.ts
│   │   ├── server-context.ts
│   │   └── server-process.ts
│   ├── integration/
│   │   ├── completions.int.test.ts
│   │   ├── config.int.test.ts
│   │   ├── error-handler.int.test.ts
│   │   ├── http-auth-sessions.test.ts
│   │   ├── http-auth.test.ts
│   │   ├── http-authz.e2e.test.ts
│   │   ├── http-protocol-session.int.test.ts
│   │   ├── http-sessions.test.ts
│   │   ├── http-sse-abort.int.test.ts
│   │   ├── http-transport.int.test.ts
│   │   ├── http.test.ts
│   │   ├── logger.int.test.ts
│   │   ├── mcp-apps.int.test.ts
│   │   ├── modern-notifications.int.test.ts
│   │   ├── multi-round-trip.int.test.ts
│   │   ├── oauth-jwks.int.test.ts
│   │   ├── package-consumer.int.test.ts
│   │   ├── public-api-contract.int.test.ts
│   │   ├── setup.ts
│   │   ├── stdio.test.ts
│   │   ├── union-input.int.test.ts
│   │   └── wire-conformance.int.test.ts
│   ├── smoke/
│   │   ├── prompts/
│   │   │   └── code-review.prompt.test.ts
│   │   ├── resources/
│   │   │   ├── echo-app-ui.app-resource.test.ts
│   │   │   └── echo.resource.test.ts
│   │   ├── services/
│   │   │   └── canvas-duckdb.test.ts
│   │   └── tools/
│   │       ├── template-data-explorer.app-tool.test.ts
│   │       ├── template-echo-app.app-tool.test.ts
│   │       ├── template-echo-message.tool.test.ts
│   │       └── template-madlibs-elicitation.tool.test.ts
│   ├── types/
│   │   ├── context-helpers.test-d.ts
│   │   ├── error-contract.test-d.ts
│   │   ├── handler-context.test-d.ts
│   │   ├── mock-context.test-d.ts
│   │   ├── request-context.test-d.ts
│   │   ├── tool-builder.test-d.ts
│   │   └── tool-contract-suite.test-d.ts
│   ├── unit/
│   │   ├── cli/
│   │   │   └── init.test.ts
│   │   ├── config/
│   │   │   ├── index.test.ts
│   │   │   ├── logLevelAlias.test.ts
│   │   │   └── parseEnvConfig.test.ts
│   │   ├── core/
│   │   │   ├── app.test.ts
│   │   │   ├── context.test.ts
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
│   │   │   ├── name-rules.test.ts
│   │   │   ├── portability-rules.test.ts
│   │   │   ├── prompt-rules.test.ts
│   │   │   ├── resource-rules.test.ts
│   │   │   ├── schema-rules.test.ts
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
│   │   │   ├── tools/
│   │   │   │   ├── utils/
│   │   │   │   │   ├── schemaShape.test.ts
│   │   │   │   │   ├── toolDefinition.test.ts
│   │   │   │   │   └── toolHandlerFactory.test.ts
│   │   │   │   ├── content.test.ts
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
│   │   │   │   │   ├── eventStore.test.ts
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
│   │   │   ├── notifications.test.ts
│   │   │   └── server.test.ts
│   │   ├── packaging/
│   │   │   ├── dockerfile.test.ts
│   │   │   ├── export-map.test.ts
│   │   │   └── optional-peer-deps.test.ts
│   │   ├── public-api/
│   │   │   └── type-contract.test.ts
│   │   ├── scripts/
│   │   │   ├── build-changelog.test.ts
│   │   │   ├── check-dependency-specifiers.test.ts
│   │   │   ├── check-skill-versions.test.ts
│   │   │   ├── clean-mcpb.test.ts
│   │   │   ├── devcheck-git-guard.test.ts
│   │   │   ├── devdocs.test.ts
│   │   │   ├── lint-packaging.test.ts
│   │   │   └── tree.test.ts
│   │   ├── services/
│   │   │   ├── canvas/
│   │   │   │   ├── appendValueCoerce.test.ts
│   │   │   │   ├── canvasFactory.test.ts
│   │   │   │   ├── CanvasRegistry.test.ts
│   │   │   │   ├── classifyDuckdbError.test.ts
│   │   │   │   ├── DataCanvas.test.ts
│   │   │   │   ├── duckdbTempRoot.test.ts
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
│   │   │   │   ├── defineMirror.test.ts
│   │   │   │   ├── handle.test.ts
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
│   │   │   ├── StorageService.boundaries.test.ts
│   │   │   ├── StorageService.metrics.test.ts
│   │   │   └── StorageService.test.ts
│   │   ├── testing/
│   │   │   ├── exports.test.ts
│   │   │   ├── fuzz-branches.test.ts
│   │   │   ├── mockContext.test.ts
│   │   │   ├── mockContextFidelity.test.ts
│   │   │   ├── mockContextState.test.ts
│   │   │   ├── test-kit.test.ts
│   │   │   ├── tool-contract-suite.test.ts
│   │   │   └── vitest.test.ts
│   │   ├── types-global/
│   │   │   └── errors.test.ts
│   │   ├── utils/
│   │   │   ├── formatting/
│   │   │   │   ├── diffFormatter.branches.test.ts
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
│   │   │   │   ├── execution-span-context.test.ts
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
│   │   │   │   ├── fetchWithTimeout.bodyDeadline.test.ts
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
│   │   │   │   ├── htmlExtractor.branches.test.ts
│   │   │   │   ├── htmlExtractor.test.ts
│   │   │   │   ├── inputBudget.test.ts
│   │   │   │   ├── inputBudgetDependencies.test.ts
│   │   │   │   ├── jsonParser.test.ts
│   │   │   │   ├── pdfParser.branches.test.ts
│   │   │   │   ├── pdfParser.imageCap.test.ts
│   │   │   │   ├── pdfParser.test.ts
│   │   │   │   ├── xmlParser.test.ts
│   │   │   │   └── yamlParser.test.ts
│   │   │   ├── scheduling/
│   │   │   │   ├── scheduler.runtime.test.ts
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
│   │   ├── create-worker-handler.worker.test.ts
│   │   ├── encoding.worker.test.ts
│   │   ├── fetch-with-timeout.worker.test.ts
│   │   ├── storage-d1.worker.test.ts
│   │   ├── storage-provider-compliance.worker.test.ts
│   │   └── storage-r2.worker.test.ts
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
├── tsconfig.base.json
├── tsconfig.build.json
├── tsconfig.json
├── tsconfig.scripts.json
├── tsdoc.json
├── typedoc.json
├── vitest.config.base.mjs
├── vitest.config.ts
├── vitest.integration.ts
├── vitest.package.ts
├── vitest.worker.ts
└── wrangler.jsonc
```

_Note: This tree excludes files and directories matched by .gitignore and default patterns._
