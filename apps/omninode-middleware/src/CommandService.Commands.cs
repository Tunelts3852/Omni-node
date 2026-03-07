using System.Diagnostics;
using System.Globalization;
using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace OmniNode.Middleware;

public sealed partial class CommandService
{
    private static readonly Regex CitationBracketRegex = new(
        @"\[(?<id>c[0-9a-z_-]+)\]",
        RegexOptions.Compiled | RegexOptions.IgnoreCase
    );
    private static readonly Regex CitationSentenceSplitRegex = new(
        @"(?<=[\.\!\?。！？])\s+",
        RegexOptions.Compiled
    );
    private static readonly Regex RequestedCountRegex = new(
        @"(?<!\d)(?<n>[1-9]\d?)\s*(개|건|가지|뉴스|news|items?|results?)",
        RegexOptions.Compiled | RegexOptions.IgnoreCase
    );
    private static readonly Regex TopCountRegex = new(
        @"(?:top|상위)\s*(?<n>[1-9]\d?)",
        RegexOptions.Compiled | RegexOptions.IgnoreCase
    );
    private static readonly IReadOnlyDictionary<string, string> SourceLabelByHostSuffix = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
    {
        ["kbs.co.kr"] = "KBS 뉴스",
        ["mbc.co.kr"] = "MBC 뉴스",
        ["sbs.co.kr"] = "SBS 뉴스",
        ["yna.co.kr"] = "연합뉴스",
        ["yonhapnews.co.kr"] = "연합뉴스",
        ["cnn.com"] = "CNN",
        ["bbc.com"] = "BBC",
        ["reuters.com"] = "Reuters",
        ["apnews.com"] = "AP News",
        ["mk.co.kr"] = "매일경제",
        ["hankyung.com"] = "한국경제",
        ["chosun.com"] = "조선일보",
        ["joongang.co.kr"] = "중앙일보",
        ["donga.com"] = "동아일보",
        ["khan.co.kr"] = "경향신문",
        ["hani.co.kr"] = "한겨레",
        ["newsis.com"] = "뉴시스",
        ["edaily.co.kr"] = "이데일리",
        ["seoul.co.kr"] = "서울신문",
        ["nocutnews.co.kr"] = "노컷뉴스",
        ["news.naver.com"] = "네이버 뉴스",
        ["korea.kr"] = "대한민국 정책브리핑"
    };
    private static CodingWorkerResult BuildUnsupportedCodingWorkerResult(
        string provider,
        string model,
        string language,
        string message
    )
    {
        var execution = new CodeExecutionResult(
            language,
            "-",
            "-",
            "(none)",
            0,
            string.Empty,
            message,
            "skipped"
        );
        return new CodingWorkerResult(
            provider,
            model,
            language,
            string.Empty,
            message,
            execution,
            Array.Empty<string>()
        );
    }
}
