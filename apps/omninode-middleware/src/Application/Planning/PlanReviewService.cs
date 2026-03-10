using System.Text;

namespace OmniNode.Middleware;

public sealed class PlanReviewService
{
    private readonly LlmRouter _llmRouter;
    private readonly RoutingPolicyResolver _routingPolicyResolver;
    private readonly ProjectContextLoader _projectContextLoader;

    public PlanReviewService(
        LlmRouter llmRouter,
        RoutingPolicyResolver routingPolicyResolver,
        ProjectContextLoader projectContextLoader
    )
    {
        _llmRouter = llmRouter;
        _routingPolicyResolver = routingPolicyResolver;
        _projectContextLoader = projectContextLoader;
    }

    public async Task<PlanReviewResult> ReviewAsync(
        WorkPlan plan,
        CancellationToken cancellationToken
    )
    {
        var findings = new List<string>();
        var risks = new List<string>();
        var missingVerification = new List<string>();

        if (plan.Steps.Count < 2)
        {
            findings.Add("단계 수가 너무 적어서 실행 단위가 충분히 분해되지 않았습니다.");
        }

        if (plan.Constraints.Count == 0)
        {
            risks.Add("명시적 제약사항이 없어 범위가 쉽게 확장될 수 있습니다.");
        }

        if (!plan.Steps.Any(step => step.Verification != null && step.Verification.Count > 0))
        {
            missingVerification.Add("검증 단계가 없어 완료 판단 기준이 불명확합니다.");
        }

        foreach (var step in plan.Steps)
        {
            if (step.Verification == null || step.Verification.Count == 0)
            {
                missingVerification.Add($"{step.StepId}: 검증 기준이 비어 있습니다.");
            }
        }

        var normalizedObjective = (plan.Objective ?? string.Empty).ToLowerInvariant();
        if ((normalizedObjective.Contains("배포", StringComparison.Ordinal)
            || normalizedObjective.Contains("release", StringComparison.Ordinal)
            || normalizedObjective.Contains("migration", StringComparison.Ordinal)
            || normalizedObjective.Contains("삭제", StringComparison.Ordinal))
            && !plan.Steps.Any(step =>
                step.Description.Contains("rollback", StringComparison.OrdinalIgnoreCase)
                || step.Description.Contains("되돌", StringComparison.OrdinalIgnoreCase)
                || step.Description.Contains("백업", StringComparison.OrdinalIgnoreCase)))
        {
            risks.Add("되돌리기 또는 백업 경로가 명시되지 않았습니다.");
        }

        var reviewerChain = _routingPolicyResolver.ResolveProviderChain(TaskCategory.Reviewer);
        var reviewerRoute = _llmRouter.ResolvePlanningRoute("reviewer", reviewerChain);
        var projectContext = _projectContextLoader.BuildPromptContext(
            _projectContextLoader.LoadSnapshot(),
            2200
        );
        var llmSummary = await _llmRouter.ReviewWorkPlanAsync(
            plan,
            projectContext,
            reviewerChain,
            cancellationToken
        );
        _routingPolicyResolver.ResolveDecision(
            TaskCategory.Reviewer,
            "auto",
            BuildPlanningAvailabilitySnapshot(reviewerRoute),
            reason: "plan_review"
        );
        var summary = BuildSummary(findings, risks, missingVerification, llmSummary);
        var recommendation = findings.Count == 0 && risks.Count == 0 && missingVerification.Count <= 1;

        return new PlanReviewResult(
            plan.PlanId,
            DateTimeOffset.UtcNow,
            summary,
            findings,
            risks,
            missingVerification,
            recommendation,
            reviewerRoute
        );
    }

    private static string BuildSummary(
        IReadOnlyList<string> findings,
        IReadOnlyList<string> risks,
        IReadOnlyList<string> missingVerification,
        string llmSummary
    )
    {
        var builder = new StringBuilder();
        if (findings.Count == 0 && risks.Count == 0 && missingVerification.Count == 0)
        {
            builder.Append("핵심 누락은 보이지 않습니다. 승인 전 마지막 검증 명령만 확인하면 됩니다.");
        }
        else
        {
            builder.Append("승인 전 보완이 필요한 지점이 있습니다.");
            if (findings.Count > 0)
            {
                builder.Append($" findings={findings.Count}");
            }

            if (risks.Count > 0)
            {
                builder.Append($" risks={risks.Count}");
            }

            if (missingVerification.Count > 0)
            {
                builder.Append($" verificationGaps={missingVerification.Count}");
            }
        }

        var trimmedLlm = (llmSummary ?? string.Empty).Trim();
        if (trimmedLlm.Length > 0)
        {
            builder.AppendLine();
            builder.Append(trimmedLlm);
        }

        return builder.ToString().Trim();
    }

    private static IReadOnlyList<ProviderAvailability> BuildPlanningAvailabilitySnapshot(string route)
    {
        var provider = (route ?? string.Empty)
            .Split(':', StringSplitOptions.RemoveEmptyEntries)
            .Skip(1)
            .FirstOrDefault();
        if (string.IsNullOrWhiteSpace(provider) || provider.Equals("fallback", StringComparison.OrdinalIgnoreCase))
        {
            return Array.Empty<ProviderAvailability>();
        }

        return new[]
        {
            new ProviderAvailability(
                provider,
                true,
                "planning_route",
                provider.Equals("gemini", StringComparison.OrdinalIgnoreCase),
                true,
                provider.Equals("gemini", StringComparison.OrdinalIgnoreCase),
                provider.Equals("copilot", StringComparison.OrdinalIgnoreCase)
                    || provider.Equals("codex", StringComparison.OrdinalIgnoreCase),
                !provider.Equals("copilot", StringComparison.OrdinalIgnoreCase)
                    && !provider.Equals("codex", StringComparison.OrdinalIgnoreCase))
        };
    }
}
