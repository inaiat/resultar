package analyzer

import (
	"context"
	"path/filepath"
	"strings"
	"testing"

	"github.com/microsoft/typescript-go/resultar-check/internal/config"
	"github.com/microsoft/typescript-go/resultar-check/internal/project"
)

const taskToolingFixture = `
export declare class ResultTask<A, E = never, R = never> {
 readonly value: A; readonly error: E; readonly requirements: R
 static gen<Y,A>(body: () => Generator<Y,A,unknown>): ResultTask<A>
 static fn<Y,A>(body: () => Generator<Y,A,unknown>): () => ResultTask<A>
 static fail<E>(error:E):ResultTask<never,E>
 static acquireDisposable<A,E,R>(task:ResultTask<A,E,R>):ResultTask<A,E,R>
 catchAll<B,E2,R2>(handler:(error:E)=>ResultTask<B,E2,R2>):ResultTask<A|B,E2,R|R2>
 catchTag<K extends string,B,E2,R2>(tag:K,handler:(error:E)=>ResultTask<B,E2,R2>):ResultTask<A|B,E2,R|R2>
 catchTags<B,E2,R2>(handlers: {Missing?:(error:Missing)=>ResultTask<B,E2,R2>;Denied?:(error:Denied)=>ResultTask<B,E2,R2>}):ResultTask<A|B,E2,R|R2>
 [Symbol.iterator](): Generator<never,A,unknown>
}
export interface Clock { now(): number }
export interface Session { id:string }
export type Missing = {readonly _tag:'Missing'}
export type Denied = {readonly _tag:'Denied'}
export declare const task: ResultTask<number,Missing|Denied,Clock>
export declare const recover: (error:Missing|Denied)=>ResultTask<number>
export declare class ServiceTag<Id,Contract> {readonly identifier:Id;readonly contract:Contract}
export declare const ClockTag: ServiceTag<'Clock',Clock>
export declare class MissingError extends Error {readonly _tag:'MissingError'}
`

func TestTaskRequirementSafety(t *testing.T) {
	directory := writeFixture(t, taskToolingFixture+`
type Alias<R> = ResultTask<number,Missing,R>
declare const unknownRequirements: Alias<unknown>
declare const anyRequirements: Alias<any>
declare const safe: ResultTask<number,Missing,never>
declare const serviceTask: ResultTask<number,Missing,Clock|Session>
void unknownRequirements;void anyRequirements;void safe
void (serviceTask as ResultTask<number,Missing,Clock>)
void (serviceTask as unknown as ResultTask<number,Missing,never>)
declare const scoped: ResultTask<number,Missing,{readonly releaseError:'release'}>
void (scoped as unknown as ResultTask<number,Missing,never>)
void (((serviceTask as unknown)) as ResultTask<number,Missing,never>)
`)
	opened, diagnostics, err := project.Open(filepath.Join(directory, "tsconfig.json"))
	if err != nil || len(diagnostics) > 0 {
		t.Fatalf("open: %v %v", err, diagnostics)
	}
	findings, err := Run(context.Background(), opened.Program, opened.Directory, config.Defaults())
	if err != nil {
		t.Fatal(err)
	}
	counts := map[string]int{}
	for _, finding := range findings {
		counts[finding.Rule]++
		if finding.Rule == "unsafe-result-type-assertion" && !strings.Contains(finding.Message, "requirements channel") {
			t.Fatalf("wrong channel: %#v", finding)
		}
	}
	if counts["no-unknown-task-requirements"] != 2 || counts["unsafe-result-type-assertion"] != 4 {
		t.Fatalf("missing requirement protection: %#v", findings)
	}
}

func TestUnusedSuppressionsTrackEachEnabledRule(t *testing.T) {
	directory := writeFixture(t, `
type Result<T,E>={value:T;error:E}
declare function save():Result<string,Error>
// resultar-check-disable-next-line no-discard no-unknown-result-error
save()
// resultar-check-disable-next-line no-throw
void 1
// resultar-check-disable-next-line
void 2
// resultar-check-disable-next-line nonexistent
void 3
const example = "// resultar-check-disable-next-line no-discard"
const template = `+"`literal ${1} // resultar-check-disable-next-line no-discard`"+`
const nested = `+"`outer ${`inner ${1}`} tail`"+`
// resultar-check-disable-next-line no-discard
save()
void example;void template;void nested
`)
	opened, _, err := project.Open(filepath.Join(directory, "tsconfig.json"))
	if err != nil {
		t.Fatal(err)
	}
	findings, err := Run(context.Background(), opened.Program, opened.Directory, config.Defaults())
	if err != nil {
		t.Fatal(err)
	}
	if len(findings) != 3 {
		t.Fatalf("unexpected suppression findings: %#v", findings)
	}
	for _, finding := range findings {
		if finding.Rule != "unused-suppression" || len(finding.Fixes) != 1 {
			t.Fatalf("missing preview: %#v", finding)
		}
	}
	if !strings.Contains(findings[0].Message, "nounknownresulterror") || findings[0].Fixes[0].Edits[0].Length != len("no-unknown-result-error") {
		t.Fatalf("must remove only unused entry: %#v", findings[0])
	}
}

func TestFnGeneratorDiagnostics(t *testing.T) {
	directory := writeFixture(t, taskToolingFixture+`
export const invalid = ResultTask.fn(function*(){yield task;return task})
export const unscoped = ResultTask.fn(function*(){return yield* ResultTask.acquireDisposable(task)})
`)
	opened, _, err := project.Open(filepath.Join(directory, "tsconfig.json"))
	if err != nil {
		t.Fatal(err)
	}
	findings, err := Run(context.Background(), opened.Program, opened.Directory, config.Defaults())
	if err != nil {
		t.Fatal(err)
	}
	counts := map[string]int{}
	for _, finding := range findings {
		counts[finding.Rule]++
	}
	if counts["yield-star-in-result-task-gen"] != 1 || counts["no-result-in-task-gen"] != 1 || counts["no-unscoped-acquire-release"] != 1 {
		t.Fatalf("fn recognition: %#v", findings)
	}
}

func TestOverviewHoverAndSafeRefactors(t *testing.T) {
	source := taskToolingFixture + `
export const simplified = ResultTask.gen(function*(){return yield* task})
export const retained = ResultTask.gen(function*(){try{return yield* task}finally{void 1}})
export const byTag = task.catchAll((error: Missing|Denied)=>error._tag==='Missing'?recover(error):ResultTask.fail(error))
const handleMissing = recover
const handleDenied = recover
export const merged = task.catchTag('Missing',handleMissing).catchTag('Denied',handleDenied)
const introducesDenied = (_error:Missing|Denied):ResultTask<number,Denied>=>ResultTask.fail({_tag:'Denied'})
export const retainedRecovery = task.catchTag('Missing',introducesDenied).catchTag('Denied',handleDenied)
const broad = (_error:Missing|Denied):ResultTask<number,Error>=>ResultTask.fail(new Error())
const handleAnyError = (_error:Error)=>task
export const retainedBroadRecovery = task.catchTag('Missing',broad).catchTag('Denied',handleAnyError)
export const later = ResultTask.gen(function*(){return yield* future})
const future = task
export function workflow(): ResultTask<number,Missing|Denied,Clock>{return task}
`
	directory := writeFixture(t, source)
	path := filepath.Join(directory, "fixture.ts")
	opened, _, err := project.Open(filepath.Join(directory, "tsconfig.json"))
	if err != nil {
		t.Fatal(err)
	}
	overview, err := BuildOverview(context.Background(), opened.Program, opened.Directory, config.Defaults())
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, entry := range overview.Entries {
		if entry.Name == "workflow" {
			found = true
			if entry.Kind != "function" || entry.Channels.Success != "number" || entry.Channels.Requirements != "Clock" {
				t.Fatalf("wrong channels: %#v", entry)
			}
		}
	}
	if !found {
		t.Fatalf("missing workflow: %#v", overview)
	}
	services, errors := 0, 0
	for _, entry := range overview.Entries {
		if entry.Kind == "service" && entry.Identifier == "\"Clock\"" {
			services++
		}
		if entry.Kind == "error" && entry.Tag == "\"MissingError\"" {
			errors++
		}
	}
	if services != 1 || errors != 1 {
		t.Fatalf("missing services/errors: %#v", overview)
	}
	hover, err := HoverAt(context.Background(), opened.Program, path, strings.Index(source, "yield* task")+len("yield* "))
	if err != nil || !strings.Contains(hover, "Requirements R") || !strings.Contains(hover, "Clock") {
		t.Fatalf("hover: %s %v", hover, err)
	}
	for _, offset := range []int{strings.Index(source, "yield* task"), strings.Index(source, "yield* task") + 5} {
		text, err := HoverAt(context.Background(), opened.Program, path, offset)
		if err != nil || !strings.Contains(text, "Requirements R") {
			t.Fatalf("yield hover: %s %v", text, err)
		}
	}
	refactors, err := Refactors(context.Background(), opened.Program, path)
	if err != nil {
		t.Fatal(err)
	}
	counts := map[string]int{}
	for _, fix := range refactors {
		counts[fix.Title]++
	}
	if counts["Simplify delegating task generator"] != 1 || counts["Recover task failures by tag"] != 1 || counts["Combine tagged task recovery"] != 1 {
		t.Fatalf("unsafe or missing refactors: %#v", refactors)
	}
	// Compile each proposed edit against a fresh snapshot, as an editor would.
	for _, fix := range refactors {
		edited := source
		for i := len(fix.Edits) - 1; i >= 0; i-- {
			edit := fix.Edits[i]
			edited = edited[:edit.Start] + edit.NewText + edited[edit.Start+edit.Length:]
		}
		next, diagnostics, err := project.OpenWithOverlay(opened.ConfigPath, map[string]string{path: edited})
		if err != nil || len(diagnostics) > 0 {
			t.Fatalf("preview project: %v %v", err, diagnostics)
		}
		if diagnostics := next.Program.GetSemanticDiagnostics(context.Background(), nil); len(diagnostics) > 0 {
			t.Fatalf("invalid refactor %s: %v", fix.Title, diagnostics)
		}
	}
}
