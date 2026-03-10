using System.Text;

namespace OmniNode.Middleware;

public sealed record PlanExecutionEnvelope(
    string Input,
    string Scope,
    string Mode,
    string ConversationTitle,
    string Project,
    string Category,
    IReadOnlyList<string> Tags,
    string Language
);

public sealed class PlanExecutionBridge
{
    private readonly ProjectContextLoader _projectContextLoader;

    public PlanExecutionBridge(ProjectContextLoader projectContextLoader)
    {
        _projectContextLoader = projectContextLoader;
    }

    public PlanExecutionEnvelope CreateExecutionEnvelope(WorkPlan plan)
    {
        var builder = new StringBuilder();
        builder.AppendLine("다음 승인된 계획을 실제 저장소 작업으로 실행하라.");
        builder.AppendLine();
        builder.AppendLine("[프로젝트 문맥]");
        builder.AppendLine(_projectContextLoader.BuildPromptContext(
            _projectContextLoader.LoadSnapshot(),
            2200
        ));
        builder.AppendLine();
        builder.AppendLine("[목표]");
        builder.AppendLine(plan.Objective);
        builder.AppendLine();

        if (plan.Constraints.Count > 0)
        {
            builder.AppendLine("[제약사항]");
            foreach (var item in plan.Constraints)
            {
                builder.AppendLine($"- {item}");
            }

            builder.AppendLine();
        }

        builder.AppendLine("[단계]");
        for (var i = 0; i < plan.Steps.Count; i += 1)
        {
            var step = plan.Steps[i];
            builder.AppendLine($"{i + 1}. {step.Description}");
            foreach (var item in step.MustDo)
            {
                builder.AppendLine($"   - must_do: {item}");
            }

            foreach (var item in step.MustNotDo)
            {
                builder.AppendLine($"   - must_not_do: {item}");
            }

            foreach (var item in step.Verification)
            {
                builder.AppendLine($"   - verification: {item}");
            }
        }

        builder.AppendLine();
        builder.AppendLine("[출력 규칙]");
        builder.AppendLine("- 실제로 변경한 내용만 반영한다.");
        builder.AppendLine("- 검증을 실행하고 실패하면 실패를 그대로 보고한다.");
        builder.AppendLine("- 마지막에는 변경 내용, 검증 결과, 남은 리스크만 간결하게 정리한다.");

        return new PlanExecutionEnvelope(
            builder.ToString().Trim(),
            "coding",
            "orchestration",
            $"[plan] {plan.Title}",
            "planning",
            "plan",
            new[] { "plan", plan.PlanId },
            "text"
        );
    }
}
