namespace OmniNode.Middleware;

internal static class Program
{
    public static async Task Main(string[] args)
    {
        _ = args;

        var config = AppConfig.LoadFromEnvironment();
        var runtimeSettings = new RuntimeSettings(config);
        using var telegramClient = new TelegramClient(runtimeSettings);
        var sessionManager = new SessionManager(config.AuthSessionStatePath);
        var coreClient = new UdsCoreClient(config.CoreSocketPath);
        using var llmRouter = new LlmRouter(config, runtimeSettings);
        using var groqModelCatalog = new GroqModelCatalog(config, runtimeSettings);
        var memoryNoteStore = new MemoryNoteStore(config.MemoryNotesRootDir);
        var conversationStore = new ConversationStore(config.ConversationStatePath);
        IMemoryNoteStore memoryNoteStoreService = memoryNoteStore;
        IConversationStore conversationStoreService = conversationStore;
        IAuthSessionStore authSessionStore = sessionManager;
        IRoutineStore routineStore = new FileRoutineStore(config.RoutineStatePath);
        IRunArtifactStore runArtifactStore = new FileRunArtifactStore(config.RoutineRunsRootDir);
        var codeRunner = new UniversalCodeRunner(config.CodeRunsRootDir, config.CodeExecutionTimeoutSec);
        var copilotWrapper = new CopilotCliWrapper(
            config.CopilotCliBinary,
            config.CopilotDirectBinary,
            config.CopilotModel,
            config.CopilotUsageStatePath,
            Math.Max(config.LlmTimeoutSec, 120)
        );
        var codexWrapper = new CodexCliWrapper(
            config.CodexBinary,
            runtimeSettings,
            config.WorkspaceRootDir,
            config.CodexModel,
            Math.Max(config.LlmTimeoutSec, 120)
        );
        var providerRegistry = new ProviderRegistry(llmRouter, copilotWrapper, codexWrapper);
        var toolRegistry = new ToolRegistry(runtimeSettings);
        var geminiGroundedRetriever = new GeminiGroundedRetriever(config, runtimeSettings);
        var searchEvidencePackBuilder = new DefaultSearchEvidencePackBuilder();
        var searchGuard = new DefaultSearchGuard();
        var searchGateway = new LegacyGeminiGroundingSearchGateway(geminiGroundedRetriever, searchEvidencePackBuilder);
        var searchAnswerComposer = new EvidenceFallbackSearchAnswerComposer(searchGateway, searchGuard);
        var webFetchTool = new WebFetchTool(config);
        var memorySearchTool = new MemorySearchTool(config);
        var memoryGetTool = new MemoryGetTool(config);
        var sessionListTool = new SessionListTool(conversationStore);
        var sessionHistoryTool = new SessionHistoryTool(conversationStore);
        var sessionSendTool = new SessionSendTool(conversationStore);
        var acpSessionBindingAdapter = new AcpSessionBindingAdapter(
            config.WorkspaceRootDir,
            config.CodexBinary,
            runtimeSettings
        );
        var sessionSpawnTool = new SessionSpawnTool(conversationStore, acpSessionBindingAdapter);
        var browserTool = new BrowserTool(config);
        var canvasTool = new CanvasTool(config);
        var nodesTool = new NodesTool(config);
        var memoryIndexSchemaBootstrap = new MemoryIndexSchemaBootstrap(config);
        try
        {
            var memoryIndexSnapshot = memoryIndexSchemaBootstrap.EnsureInitialized();
            var memoryIndexDocumentSync = new MemoryIndexDocumentSync(config, memoryIndexSnapshot);
            var syncSnapshot = memoryIndexDocumentSync.SyncOnce();
            if (memoryIndexSnapshot.FtsAvailable)
            {
                Console.WriteLine($"[memory-index] ready db={memoryIndexSnapshot.DbPath} fts=available");
            }
            else
            {
                Console.WriteLine(
                    $"[memory-index] ready db={memoryIndexSnapshot.DbPath} fts=unavailable error={memoryIndexSnapshot.FtsError}"
                );
            }

            Console.WriteLine(
                "[memory-index] sync "
                + $"scanned={syncSnapshot.ScannedDocuments} "
                + $"indexed={syncSnapshot.IndexedDocuments} "
                + $"skipped={syncSnapshot.SkippedDocuments} "
                + $"removed={syncSnapshot.RemovedDocuments} "
                + $"fts={(syncSnapshot.FtsAvailable ? "available" : "unavailable")}"
            );
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine($"[memory-index] bootstrap or sync failed: {ex.Message}");
        }
        var sandboxClient = new PythonSandboxClient(config.PythonBinary, config.SandboxExecutorPath);
        var auditLogger = new AuditLogger(config.AuditLogPath);
        var commandService = new CommandService(
            config,
            llmRouter,
            groqModelCatalog,
            coreClient,
            telegramClient,
            runtimeSettings,
            providerRegistry,
            toolRegistry,
            searchGateway,
            searchGuard,
            searchAnswerComposer,
            webFetchTool,
            memorySearchTool,
            memoryGetTool,
            sessionListTool,
            sessionHistoryTool,
            sessionSendTool,
            sessionSpawnTool,
            browserTool,
            canvasTool,
            nodesTool,
            copilotWrapper,
            codexWrapper,
            sandboxClient,
            memoryNoteStoreService,
            conversationStoreService,
            routineStore,
            runArtifactStore,
            codeRunner,
            auditLogger
        );
        var commandExecutionService = new CommandExecutionService(commandService);
        var settingsApplicationService = new SettingsApplicationService(commandService);
        var conversationApplicationService = new ConversationApplicationService(commandService);
        var memoryApplicationService = new MemoryApplicationService(commandService);
        var toolApplicationService = new ToolApplicationService(commandService);
        var routineApplicationService = new RoutineApplicationService(commandService);
        var chatApplicationService = new ChatApplicationService(commandService);
        var codingApplicationService = new CodingApplicationService(commandService);

        var webSocketGateway = new WebSocketGateway(
            config,
            config.WebSocketPort,
            authSessionStore,
            telegramClient,
            commandExecutionService,
            settingsApplicationService,
            conversationApplicationService,
            memoryApplicationService,
            toolApplicationService,
            routineApplicationService,
            chatApplicationService,
            codingApplicationService,
            llmRouter,
            groqModelCatalog,
            new GuardRetryTimelineStore(config.GuardRetryTimelineStatePath),
            auditLogger
        );

        var telegramUpdateLoop = new TelegramUpdateLoop(
            telegramClient,
            commandExecutionService,
            config
        );

        using var cts = new CancellationTokenSource();
        Console.CancelKeyPress += (_, eventArgs) =>
        {
            eventArgs.Cancel = true;
            cts.Cancel();
        };

        Console.WriteLine($"[middleware] starting (ws={config.WebSocketPort}, uds={config.CoreSocketPath})");

        var webTask = webSocketGateway.RunAsync(cts.Token);
        if (config.EnableGatewayStartupProbe)
        {
            var startupProbe = new GatewayStartupProbe(config, config.WebSocketPort);
            _ = startupProbe.RunAsync(cts.Token);
        }

        var telegramTask = telegramUpdateLoop.RunAsync(cts.Token);
        var firstCompleted = await Task.WhenAny(webTask, telegramTask);

        if (firstCompleted.IsFaulted)
        {
            cts.Cancel();
            await Task.WhenAll(webTask, telegramTask);
        }

        await Task.WhenAll(webTask, telegramTask);
    }
}
