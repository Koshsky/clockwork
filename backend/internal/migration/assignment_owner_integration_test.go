package migration //nolint:testpackage // Exercises private migration helpers in an isolated schema.

import "testing"

func TestAssignmentOwnerInvariant(t *testing.T) {
	t.Parallel()
	pool := testPool(t, true)
	if err := Run(t.Context(), pool, testLogger()); err != nil {
		t.Fatal(err)
	}
	_, err := pool.Exec(
		t.Context(),
		`INSERT INTO users(id,username,first_name,last_name,password_hash,preset) VALUES(1,'first','First','User','test','worker'),(2,'second','Second','User','test','worker');
 INSERT INTO projects(id,code,priority,owner_id,start_date,end_date) VALUES(1,'test',1,1,'2026-01-01','2026-12-31');
 INSERT INTO processes(id,project_id,sort_order,title,owner_id,start_date,end_date) VALUES(1,1,1,'First',1,'2026-01-01','2026-12-31'),(2,1,2,'Second',2,'2026-01-01','2026-12-31');
 INSERT INTO tasks(id,process_id,title,owner_id,start_date,end_date) VALUES(1,1,'Task',1,'2026-01-01','2026-12-31');
 INSERT INTO resources(id,code,title,owner_id) VALUES(1,'one','One',1),(2,'two','Two',2);`,
	)
	if err != nil {
		t.Fatal(err)
	}
	exec := func(sql string) {
		t.Helper()
		if _, e := pool.Exec(t.Context(), sql); e != nil {
			t.Fatal(e)
		}
	}
	count := func(want int) {
		t.Helper()
		var got int
		if e := pool.QueryRow(t.Context(), "SELECT count(*) FROM assignments").Scan(&got); e != nil || got != want {
			t.Fatalf("count %d want %d: %v", got, want, e)
		}
	}
	if _, err = pool.Exec(
		t.Context(),
		"INSERT INTO assignments(task_id,resource_id,quantity) VALUES(1,2,1)",
	); err == nil {
		t.Fatal("foreign resource accepted")
	}
	exec("INSERT INTO assignments(task_id,resource_id,quantity) VALUES(1,1,1)")
	count(1)
	exec("UPDATE resources SET title='Renamed',owner_id=1 WHERE id=1")
	count(1)
	tx, err := pool.Begin(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	if _, err = tx.Exec(t.Context(), "UPDATE resources SET owner_id=2 WHERE id=1"); err != nil {
		t.Fatal(err)
	}
	_ = tx.Rollback(t.Context())
	count(1)
	if _, err = pool.Exec(t.Context(), "UPDATE tasks SET process_id=2 WHERE id=1"); err == nil {
		t.Fatal("task move bypassed owner invariant")
	}
	exec("UPDATE resources SET owner_id=2 WHERE id=1")
	count(0)
	exec(
		"UPDATE resources SET owner_id=1 WHERE id=1; INSERT INTO assignments(task_id,resource_id,quantity) VALUES(1,1,1)",
	)
	exec("UPDATE processes SET title='Renamed',owner_id=1 WHERE id=1")
	count(1)
	exec("UPDATE processes SET owner_id=2 WHERE id=1")
	count(0)
}
