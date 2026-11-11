// Command go-stmt-lines prints the source range of every statement that
// `go tool cover` counts, so that coverage-check.mjs can map coverprofile
// blocks to statement start lines (the gocov approach; process-compass #360).
//
// Usage: file paths on stdin (one per line). Output: JSON on stdout
//
//	{"files": {"<path>": [[startLine, startCol, endLine, endCol], ...]}, "errors": {"<path>": "<message>"}}
//
// A statement is an element of a statement list (BlockStmt.List,
// CaseClause.Body, CommClause.Body), the same unit cmd/cover counts in
// NumStmt. Case and comm clauses themselves are not statements. Columns are
// 1-based byte columns, the same as the coverprofile.
//
// The directory name starts with "_" so that `go test ./...`, `go vet ./...`
// and similar patterns in an adopter's module never pick this program up as
// product code. It depends only on the standard library.
package main

import (
	"bufio"
	"encoding/json"
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"strings"
)

type output struct {
	Files  map[string][][4]int `json:"files"`
	Errors map[string]string   `json:"errors"`
}

func statements(fset *token.FileSet, f *ast.File) [][4]int {
	out := [][4]int{}
	add := func(list []ast.Stmt) {
		for _, s := range list {
			switch s.(type) {
			case *ast.CaseClause, *ast.CommClause:
				continue
			}
			p := fset.Position(s.Pos())
			e := fset.Position(s.End())
			out = append(out, [4]int{p.Line, p.Column, e.Line, e.Column})
		}
	}
	ast.Inspect(f, func(n ast.Node) bool {
		switch b := n.(type) {
		case *ast.BlockStmt:
			add(b.List)
		case *ast.CaseClause:
			add(b.Body)
		case *ast.CommClause:
			add(b.Body)
		}
		return true
	})
	return out
}

func main() {
	res := output{Files: map[string][][4]int{}, Errors: map[string]string{}}
	sc := bufio.NewScanner(os.Stdin)
	sc.Buffer(make([]byte, 1024*1024), 64*1024*1024)
	for sc.Scan() {
		name := strings.TrimSpace(sc.Text())
		if name == "" {
			continue
		}
		fset := token.NewFileSet()
		f, err := parser.ParseFile(fset, name, nil, parser.SkipObjectResolution)
		if err != nil {
			res.Errors[name] = err.Error()
			continue
		}
		res.Files[name] = statements(fset, f)
	}
	if err := sc.Err(); err != nil {
		os.Stderr.WriteString(err.Error() + "\n")
		os.Exit(2)
	}
	enc := json.NewEncoder(os.Stdout)
	if err := enc.Encode(res); err != nil {
		os.Stderr.WriteString(err.Error() + "\n")
		os.Exit(2)
	}
}
