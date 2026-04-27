from __future__ import annotations

from pathlib import Path

from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER, TA_LEFT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import cm
from reportlab.platypus import (
    Flowable,
    KeepTogether,
    ListFlowable,
    ListItem,
    PageBreak,
    Paragraph,
    Preformatted,
    SimpleDocTemplate,
    Spacer,
    Table,
    TableStyle,
)


ROOT = Path(__file__).resolve().parent
OUTPUT = ROOT / "resultar-v2-vs-errore-safety-report.pdf"


class HorizontalRule(Flowable):
    def __init__(self, width: float, color: colors.Color = colors.HexColor("#D7DEE8")) -> None:
        super().__init__()
        self.width = width
        self.color = color
        self.height = 0.12 * cm

    def draw(self) -> None:
        self.canv.setStrokeColor(self.color)
        self.canv.setLineWidth(0.8)
        self.canv.line(0, self.height / 2, self.width, self.height / 2)


def p(text: str, style: ParagraphStyle) -> Paragraph:
    return Paragraph(text, style)


def bullets(items: list[str], style: ParagraphStyle) -> ListFlowable:
    return ListFlowable(
        [ListItem(Paragraph(item, style), leftIndent=12) for item in items],
        bulletType="bullet",
        leftIndent=14,
        bulletFontSize=8,
        bulletColor=colors.HexColor("#334155"),
    )


def code(text: str, style: ParagraphStyle) -> Preformatted:
    return Preformatted(text.strip(), style)


def table(data: list[list[str]], widths: list[float], body_style: ParagraphStyle) -> Table:
    rows = [[Paragraph(cell, body_style) for cell in row] for row in data]
    result = Table(rows, colWidths=widths, hAlign="LEFT", repeatRows=1)
    result.setStyle(
        TableStyle(
            [
                ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#E8F0F8")),
                ("TEXTCOLOR", (0, 0), (-1, 0), colors.HexColor("#0F172A")),
                ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
                ("GRID", (0, 0), (-1, -1), 0.35, colors.HexColor("#CBD5E1")),
                ("VALIGN", (0, 0), (-1, -1), "TOP"),
                ("LEFTPADDING", (0, 0), (-1, -1), 7),
                ("RIGHTPADDING", (0, 0), (-1, -1), 7),
                ("TOPPADDING", (0, 0), (-1, -1), 6),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
                ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, colors.HexColor("#F8FAFC")]),
            ]
        )
    )
    return result


def on_page(canvas, doc) -> None:
    canvas.saveState()
    canvas.setStrokeColor(colors.HexColor("#D7DEE8"))
    canvas.setLineWidth(0.5)
    canvas.line(2 * cm, 1.55 * cm, A4[0] - 2 * cm, 1.55 * cm)
    canvas.setFont("Helvetica", 8)
    canvas.setFillColor(colors.HexColor("#64748B"))
    canvas.drawString(2 * cm, 1.05 * cm, "Resultar v2 vs Errore safety report")
    canvas.drawRightString(A4[0] - 2 * cm, 1.05 * cm, f"Page {doc.page}")
    canvas.restoreState()


def build() -> None:
    styles = getSampleStyleSheet()
    title = ParagraphStyle(
        "ReportTitle",
        parent=styles["Title"],
        fontName="Helvetica-Bold",
        fontSize=24,
        leading=30,
        textColor=colors.HexColor("#0F172A"),
        alignment=TA_CENTER,
        spaceAfter=10,
    )
    subtitle = ParagraphStyle(
        "Subtitle",
        parent=styles["Normal"],
        fontSize=10,
        leading=14,
        textColor=colors.HexColor("#475569"),
        alignment=TA_CENTER,
        spaceAfter=18,
    )
    h1 = ParagraphStyle(
        "H1",
        parent=styles["Heading1"],
        fontName="Helvetica-Bold",
        fontSize=16,
        leading=20,
        textColor=colors.HexColor("#0F172A"),
        spaceBefore=14,
        spaceAfter=8,
    )
    h2 = ParagraphStyle(
        "H2",
        parent=styles["Heading2"],
        fontName="Helvetica-Bold",
        fontSize=12,
        leading=16,
        textColor=colors.HexColor("#1E293B"),
        spaceBefore=10,
        spaceAfter=5,
    )
    body = ParagraphStyle(
        "Body",
        parent=styles["BodyText"],
        fontName="Helvetica",
        fontSize=9.2,
        leading=13,
        textColor=colors.HexColor("#1F2937"),
        alignment=TA_LEFT,
        spaceAfter=7,
    )
    small = ParagraphStyle(
        "Small",
        parent=body,
        fontSize=8.2,
        leading=11,
        textColor=colors.HexColor("#475569"),
    )
    code_style = ParagraphStyle(
        "Code",
        parent=styles["Code"],
        fontName="Courier",
        fontSize=7.6,
        leading=9.5,
        backColor=colors.HexColor("#F1F5F9"),
        borderColor=colors.HexColor("#CBD5E1"),
        borderWidth=0.4,
        borderPadding=6,
        textColor=colors.HexColor("#0F172A"),
        spaceBefore=4,
        spaceAfter=9,
    )

    doc = SimpleDocTemplate(
        str(OUTPUT),
        pagesize=A4,
        rightMargin=2 * cm,
        leftMargin=2 * cm,
        topMargin=2 * cm,
        bottomMargin=2 * cm,
        title="Resultar v2 vs Errore safety report",
        author="Codex",
        subject="Safety comparison between Resultar v2 and Errore",
    )
    width = A4[0] - 4 * cm
    story: list[Flowable] = []

    story.append(p("Resultar v2 vs Errore", title))
    story.append(
        p(
            "A safety-focused comparison for TypeScript backend services. "
            "Prepared from the current Resultar v2 branch and the published Errore 0.14.1 API.",
            subtitle,
        )
    )
    story.append(HorizontalRule(width))
    story.append(Spacer(1, 0.4 * cm))

    story.append(p("Executive Summary", h1))
    story.append(
        p(
            "Resultar v2 is the safer default when the team wants explicit control flow, "
            "unambiguous success and failure variants, and TypeScript narrowing that prevents "
            "access to the wrong branch. Errore is safer when the team wants very low ceremony "
            "and is willing to enforce a strict rule that all failures are Error instances and "
            "success values are never Error instances.",
            body,
        )
    )
    story.append(
        bullets(
            [
                "<b>Recommendation:</b> keep Resultar v2's wrapper model for service code where correctness matters more than terseness.",
                "<b>Borrow selectively:</b> the useful Errore idea is ergonomic tagged errors, especially allowing createTaggedError({ name }) for dynamic messages.",
                "<b>Avoid copying:</b> do not replicate Errore's top-level value-or-Error helper API unless the project intentionally supports a second result model.",
                "<b>Most important safety win:</b> Resultar v2 now exposes value only on Ok and error only on Err after narrowing.",
            ],
            body,
        )
    )

    story.append(p("High-Level Verdict", h1))
    verdict = [
        ["Dimension", "Safer choice", "Reason"],
        [
            "Branch narrowing",
            "Resultar v2",
            "isOk() and isErr() narrow to separate OkResult and ErrResult types, preventing wrong property access.",
        ],
        [
            "Ambiguous values",
            "Resultar v2",
            "A successful value can be an Error without being mistaken for a failure.",
        ],
        [
            "Error consistency",
            "Errore",
            "Errore's failure channel is constrained to Error subclasses, which encourages consistent stack, cause, and message metadata.",
        ],
        [
            "Pipeline clarity",
            "Resultar v2",
            "Transformations happen on a known wrapper object rather than a raw T | Error union.",
        ],
        [
            "Ergonomics",
            "Errore",
            "Function calls and plain unions are shorter, especially around async/await and catch.",
        ],
        [
            "Backend correctness",
            "Resultar v2",
            "More explicit, less ambiguous, and harder to misuse in larger flows.",
        ],
    ]
    story.append(table(verdict, [3.2 * cm, 3.3 * cm, width - 6.5 * cm], small))

    story.append(PageBreak())

    story.append(p("Core Model Comparison", h1))
    story.append(p("Errore represents the result as a raw union:", body))
    story.append(code("type Errore<T, E extends Error = Error> = T | E", code_style))
    story.append(
        p(
            "This is compact and familiar in JavaScript. The tradeoff is that correctness depends "
            "on a convention: failures must be Error instances, and success values should not be Error instances.",
            body,
        )
    )
    story.append(p("Resultar v2 represents the result as explicit variants:", body))
    story.append(
        code(
            """
type Result<T, E> = OkResult<T, E> | ErrResult<T, E>

interface OkResult<T, E> {
  readonly value: T
  isOk(): this is OkResult<T, E>
}

interface ErrResult<T, E> {
  readonly error: E
  isErr(): this is ErrResult<T, E>
}
""",
            code_style,
        )
    )
    story.append(
        p(
            "The wrapper model is more verbose, but it makes the control-flow state visible in the type system. "
            "That is the main reason Resultar v2 is safer for complex service logic.",
            body,
        )
    )

    story.append(p("Narrowing Safety", h1))
    story.append(
        p(
            "The key v2 improvement is that TypeScript can reject branch mistakes. In an Err branch, "
            "value is not part of the public type. In an Ok branch, error is not part of the public type.",
            body,
        )
    )
    story.append(
        code(
            """
const parseJson = Result.fromThrowable(JSON.parse, () => "JSON parse error")
const result = parseJson("boom")

if (result.isErr()) {
  result.error // ok: string
  result.value // TypeScript error
}
""",
            code_style,
        )
    )
    story.append(
        p(
            "Errore narrows with isError(value), which works well for Error-based failures, but it cannot "
            "distinguish between a successful Error value and a failed Error value.",
            body,
        )
    )
    story.append(
        code(
            """
const result: User | NotFoundError = await fetchUser(id)

if (isError(result)) {
  // failure branch
} else {
  // success branch
}
""",
            code_style,
        )
    )

    story.append(PageBreak())

    story.append(p("Ambiguity Risk", h1))
    ambiguity = [
        ["Scenario", "Errore", "Resultar v2"],
        [
            "Success value is an Error object",
            "Ambiguous. isError(value) treats it as failure.",
            "Unambiguous. ok(errorValue) is still Ok.",
        ],
        [
            "Failure value is a string",
            "Not supported by the typed model.",
            "Supported: Result<T, string>.",
        ],
        [
            "Failure should carry stack/cause",
            "Natural, because E extends Error.",
            "Allowed but not enforced.",
        ],
        [
            "Wrong branch property access",
            "No branch object exists, so the issue is different.",
            "Rejected by TypeScript after narrowing.",
        ],
    ]
    story.append(table(ambiguity, [4.0 * cm, 5.9 * cm, width - 9.9 * cm], small))
    story.append(Spacer(1, 0.25 * cm))
    story.append(
        p(
            "This ambiguity is the main technical reason not to replace Resultar's wrapper model with Errore's raw union model. "
            "Raw unions are elegant when the domain guarantees no overlap between success and failure values. Wrapper variants remain safer when the domain is not that strict.",
            body,
        )
    )

    story.append(p("Error Channel Policy", h1))
    story.append(
        p(
            "Errore is stricter about the error channel because errors must extend Error. That has benefits: stack traces, cause chains, message fields, and standard instanceof checks are always available.",
            body,
        )
    )
    story.append(
        p(
            "Resultar is more general. It supports Result<T, string>, Result<T, ValidationIssue[]>, Result<T, DomainError>, and other shapes. This flexibility is useful, but the team should define a project policy. For backend service code, prefer Error subclasses for infrastructure and unexpected failures, while allowing small domain error unions only when they are intentionally value-like.",
            body,
        )
    )

    story.append(p("Tagged Errors", h1))
    story.append(
        p(
            "Both libraries converge around tagged Error subclasses. This is the area where Errore has useful ergonomics that can be adopted without changing Resultar's core model.",
            body,
        )
    )
    tagged = [
        ["Capability", "Errore", "Resultar v2"],
        [
            "createTaggedError",
            "Available. message is optional and defaults to dynamic message.",
            "Available. Current branch now supports omitted message with '$message'.",
        ],
        [
            "matchError / matchErrorPartial",
            "Available.",
            "Available.",
        ],
        [
            "findCause",
            "Available.",
            "Available.",
        ],
        [
            "Integration with Result",
            "Not applicable; Errore uses raw unions.",
            "TaggedErrorClass.err() returns ErrResult, which is a strong Resultar-specific ergonomic.",
        ],
    ]
    story.append(table(tagged, [4.0 * cm, 5.6 * cm, width - 9.6 * cm], small))
    story.append(
        code(
            """
class UserNotFoundError extends createTaggedError({
  name: "UserNotFoundError",
}) {}

const error = new UserNotFoundError({ message: "User 123 not found" })
const result = UserNotFoundError.err({ message: "User 123 not found" })
""",
            code_style,
        )
    )

    story.append(PageBreak())

    story.append(p("API Surface Comparison", h1))
    api = [
        ["Area", "Errore", "Resultar v2"],
        [
            "Core values",
            "Raw T | Error unions.",
            "OkResult / ErrResult wrapper union.",
        ],
        [
            "Creation",
            "tryFn, tryAsync, direct catch chains.",
            "ok, err, tryCatch, fromThrowable, fromPromise, ResultAsync.",
        ],
        [
            "Transformation",
            "Top-level helpers: map, mapError, andThen, tap.",
            "Instance methods: result.map(), result.mapErr(), result.andThen(), result.tap().",
        ],
        [
            "Extraction",
            "unwrap, unwrapOr, match.",
            "unwrapOr, unwrapOrThrow, match, safeTry.",
        ],
        [
            "Async",
            "Plain Promise<T | Error> style.",
            "ResultAsync wrapper with typed chain methods.",
        ],
        [
            "Packaging",
            "ESM and types export.",
            "ESM and types export.",
        ],
    ]
    story.append(table(api, [3.6 * cm, 6.0 * cm, width - 9.6 * cm], small))

    story.append(p("Safety Scoring", h1))
    scoring = [
        ["Criterion", "Resultar v2", "Errore"],
        ["Wrong branch access prevention", "Strong", "N/A: raw union model"],
        ["Success/failure ambiguity", "Low", "Medium when success can be Error"],
        ["Error metadata consistency", "Medium by default", "Strong"],
        ["Async pipeline explicitness", "Strong", "Medium"],
        ["Low ceremony", "Medium", "Strong"],
        ["Migration risk in existing Resultar code", "Low", "High if replacing model"],
    ]
    story.append(table(scoring, [5.2 * cm, 5.0 * cm, width - 10.2 * cm], small))

    story.append(PageBreak())

    story.append(p("Guidance For AI-Assisted Development", h1))
    story.append(
        p(
            "When engineers use AI to write or review TypeScript error-handling code, the safest approach is to make the desired invariants explicit. "
            "AI tools tend to optimize for plausible code first; they do not automatically preserve public API contracts, type narrowing guarantees, or domain-specific error policies unless those constraints are stated and verified.",
            body,
        )
    )
    story.append(p("Prompt The AI With Safety Constraints", h2))
    story.append(
        bullets(
            [
                "Tell the AI to preserve Resultar's Result<T, E> wrapper model and not replace it with a raw T | Error union.",
                "Ask it to keep Ok and Err branch access exclusive: value only after isOk(), error only after isErr().",
                "Require type tests for public narrowing behavior whenever Result, OkResult, ErrResult, or createTaggedError types change.",
                "Ask it to compare generated declarations, not only source files, before claiming the public API is unchanged.",
                "Tell it to keep changes additive unless the task explicitly targets a major-version breaking change.",
                "Require it to run typecheck, lint, tests, and build before presenting a safety conclusion.",
            ],
            body,
        )
    )
    story.append(p("Good AI Request Example", h2))
    story.append(
        code(
            """
Update createTaggedError so createTaggedError({ name }) works.
Do not copy Errore's value-or-Error helper API.
Preserve Resultar's Result / ResultAsync public model.
Add type tests proving Err branches do not expose value.
Run tsc, lint, tests, and build.
Compare dist/index.d.ts before summarizing public API impact.
""",
            code_style,
        )
    )
    story.append(p("Unsafe AI Request Example", h2))
    story.append(
        code(
            """
Make Resultar like Errore.
""",
            code_style,
        )
    )
    story.append(
        p(
            "That request is too broad. It can lead the AI to replicate Errore's whole API, introduce a second result model, and blur the library's public direction. "
            "For safety, ask for the specific ergonomic improvement instead of asking for full similarity.",
            body,
        )
    )

    story.append(p("General Safety Guidelines", h1))
    general = [
        ["Guideline", "Why it matters"],
        [
            "Prefer explicit variants for core control flow.",
            "They make invalid states harder to express and easier for TypeScript to reject.",
        ],
        [
            "Use raw unions only when the discriminator is impossible to confuse.",
            "T | Error is safe only if successful values are never Error instances.",
        ],
        [
            "Keep public API checks close to the build output.",
            "Consumers depend on dist/index.d.ts and package exports, not only source intent.",
        ],
        [
            "Add type tests for safety properties.",
            "Runtime tests cannot prove that TypeScript rejects result.value in an Err branch.",
        ],
        [
            "Treat broad compatibility requests as design changes.",
            "A small ergonomic change is different from supporting another library's whole programming model.",
        ],
        [
            "Keep AI-generated changes small and reviewable.",
            "Small patches make it easier to catch unintended API expansion or semantic drift.",
        ],
    ]
    story.append(table(general, [6.2 * cm, width - 6.2 * cm], small))

    story.append(p("AI Review Checklist", h1))
    story.append(
        bullets(
            [
                "Did the AI add any new root exports that were not requested?",
                "Did it introduce a second abstraction model, such as raw T | Error, beside Result<T, E>?",
                "Did it preserve package exports and generated declaration filenames?",
                "Did it update tests at the right layer: runtime behavior plus type-level guarantees?",
                "Did it leave unrelated local edits untouched?",
                "Did it explain which changes are additive and which are breaking?",
                "Did it verify with tsc, lint, tests, and build?",
            ],
            body,
        )
    )

    story.append(p("Recommended Direction", h1))
    story.append(
        bullets(
            [
                "Keep Resultar v2 as the primary abstraction for backend services and product flows.",
                "Keep the OkResult / ErrResult union; it is the core safety improvement.",
                "Use tagged Error subclasses for richer domain and infrastructure failures.",
                "Adopt only the createTaggedError({ name }) ergonomic from Errore; avoid replicating the whole Errore helper API.",
                "Document a team guideline: use Error subclasses for unexpected or infrastructure failures, and use non-Error error values only when they are deliberate domain values.",
                "Require type tests for public narrowing behavior so regressions like result.value inside an Err branch are caught.",
            ],
            body,
        )
    )

    story.append(p("Decision Statement", h1))
    story.append(
        p(
            "Resultar v2 should stay a Result wrapper library, not become an Errore clone. "
            "Errore has excellent ergonomics for Error-only unions, but Resultar's explicit variant model provides stronger safety for complex application code. "
            "The best combined direction is to keep Resultar's wrapper semantics and selectively improve tagged-error ergonomics.",
            body,
        )
    )

    story.append(Spacer(1, 0.2 * cm))
    story.append(
        KeepTogether(
            [
                p("Appendix: Current Public Shape", h2),
                p(
                    "After the narrow compatibility change, Resultar's root exports remain Resultar-specific: "
                    "Result, ResultAsync, ok, err, safeTry, tryCatch, async helpers, and tagged-error helpers. "
                    "The Errore-style top-level helpers are intentionally not exported.",
                    body,
                ),
            ]
        )
    )

    doc.build(story, onFirstPage=on_page, onLaterPages=on_page)


if __name__ == "__main__":
    build()
    print(OUTPUT)
