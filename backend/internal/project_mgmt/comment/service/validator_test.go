package service_test

import (
	"strings"
	"testing"

	"github.com/Koshsky/erp-backend/internal/project_mgmt/comment/service"
	"github.com/Koshsky/erp-backend/pkg/errors"
)

// maxCommentContentLen mirrors the service limit (see comment/service/validator.go).
const maxCommentContentLen = 4000

func TestCommentValidator(t *testing.T) {
	t.Parallel()
	v := &service.CommentValidator{}

	type args struct {
		taskID, authorID int64
		content          string
	}
	valid := args{taskID: 1, authorID: 2, content: "Перенести сроки?"}

	cases := []struct {
		name    string
		args    args
		wantErr bool
	}{
		{"valid root comment", valid, false},
		{"zero task id", args{taskID: 0, authorID: 2, content: "x"}, true},
		{"zero author id", args{taskID: 1, authorID: 0, content: "x"}, true},
		{"empty content", args{taskID: 1, authorID: 2, content: "   "}, true},
		{
			"max length is allowed",
			args{taskID: 1, authorID: 2, content: strings.Repeat("x", maxCommentContentLen)},
			false,
		},
		{
			"over max length",
			args{taskID: 1, authorID: 2, content: strings.Repeat("x", maxCommentContentLen+1)},
			true,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			err := v.ValidateComment(tc.args.taskID, tc.args.authorID, tc.args.content)
			if tc.wantErr != (err != nil) {
				t.Fatalf("ValidateComment() error = %v, wantErr %v", err, tc.wantErr)
			}
			if err != nil && !errors.IsValidationError(err) {
				t.Fatalf("ValidateComment() expected validation error, got %v", err)
			}
		})
	}
}
