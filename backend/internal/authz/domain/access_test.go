package domain_test

import (
	"encoding/json"
	"reflect"
	"testing"

	"github.com/Koshsky/erp-backend/internal/authz/domain"
)

func TestResourceValues(t *testing.T) {
	t.Parallel()

	resources := []domain.Resource{
		domain.ResourceProject, domain.ResourceProcess, domain.ResourceTask,
		domain.ResourceMilestone, domain.ResourceAssignment, domain.ResourceState,
		domain.ResourceResource, domain.ResourceWorker, domain.ResourceComment,
		domain.ResourceUserCatalog, domain.ResourceRBACConfig, domain.ResourceUserAdmin,
		domain.ResourceStateAdmin, domain.ResourceOrgStructure, domain.ResourceAudit,
		domain.ResourceAutoCreate,
	}
	for value, resource := range resources {
		if int(resource) != value {
			t.Errorf("resource %d has value %d", value, resource)
		}
	}
}

func TestSharesOwnerPreservesAccessLevelComparison(t *testing.T) {
	t.Parallel()

	cases := []struct {
		name  string
		left  domain.Owners
		right domain.Owners
		want  bool
	}{
		{"zero is not ownership", domain.Owners{}, domain.Owners{}, false},
		{"project to row", domain.Owners{ProjectOwner: 7}, domain.Owners{Owner: 7}, true},
		{"process to row", domain.Owners{ProcessOwner: 7}, domain.Owners{Owner: 7}, true},
		{"process to project", domain.Owners{ProcessOwner: 7}, domain.Owners{ProjectOwner: 7}, true},
		{"project to process", domain.Owners{ProjectOwner: 7}, domain.Owners{ProcessOwner: 7}, true},
		{"different owners", domain.Owners{ProcessOwner: 7}, domain.Owners{Owner: 8}, false},
		{"row equality is insufficient", domain.Owners{Owner: 7}, domain.Owners{Owner: 7}, false},
		{"resource owner is not access level", domain.Owners{ResourceOwner: 7}, domain.Owners{Owner: 7}, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			if got := tc.left.SharesOwner(tc.right); got != tc.want {
				t.Errorf("SharesOwner() = %t, want %t", got, tc.want)
			}
		})
	}
}

func TestPrincipalJSONContract(t *testing.T) {
	t.Parallel()

	cases := []struct {
		name string
		user domain.UserContext
		want string
	}{
		{"default deny", domain.UserContext{}, `{"id":0,"admin":false}`},
		{"empty rules omitted", domain.UserContext{ID: 7, Rules: []domain.PermissionRule{}}, `{"id":7,"admin":false}`},
		{"individual deny", domain.UserContext{ID: 7, Rules: []domain.PermissionRule{
			{Resource: "task", Action: "update", Granted: false},
		}}, `{"id":7,"admin":false,"rules":[{"resource":"task","action":"update","granted":false}]}`},
		{"full principal", domain.UserContext{
			ID: 7, Admin: true, Preset: "admin", Email: "user@example.test", FullName: "User", TenantID: 9,
			Rules: []domain.PermissionRule{{Resource: "task", Action: "view", Scope: "self", Granted: true}},
		}, `{"id":7,"admin":true,"preset":"admin","email":"user@example.test","full_name":"User","tenant_id":9,` +
			`"rules":[{"resource":"task","action":"view","scope":"self","granted":true}]}`},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			encoded, err := json.Marshal(tc.user)
			if err != nil {
				t.Fatal(err)
			}
			var got, want any
			if err = json.Unmarshal(encoded, &got); err != nil {
				t.Fatal(err)
			}
			if err = json.Unmarshal([]byte(tc.want), &want); err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(got, want) {
				t.Errorf("principal JSON = %s, want %s", encoded, tc.want)
			}
		})
	}
}
