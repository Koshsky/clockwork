# Roles and permissions

Select a role and configure its capabilities. Saved rights apply to its employees unless individually overridden.

## Planning

View opens records. Manage groups creation, editing and deletion, while the server checks each action separately. Mixed permissions preserve previously different action settings until an explicit common choice is made.

Viewing a project opens all its processes, tasks, subtasks, milestones and assignments. Viewing a process opens its contents; viewing a task opens its subtasks and assignments. A child denial cannot cancel parent visibility. Disabled controls explain this on hover. Through parent only removes an independent grant while retaining inherited visibility. Management never inherits this way.

In employee projects checks the project owner; In employee processes checks the process owner. Nested records may have different owners. With employee processes opens a project containing that employee's process and thus the entire project for viewing; owning only a task is insufficient. Selected conditions are combined with OR. Previously stored advanced conditions remain effective until replaced.

Project priority is separate from other edits. An assigned resource and its process must always share an owner, even for administrators.

## Employees, timesheets and resources

- **Employees and timesheet** controls employee visibility and attendance or absence periods. Own means direct subordinates, not the employee's own account.
- **Timesheet day types** provides working-day, vacation, sickness and other day labels, unrelated to task statuses. Dictionary access does not allow changing employee calendars.
- **Planning resources** groups employees assigned to tasks and used for capacity calculations. Own means resources owned by the employee. Resource management and task assignment are separate rights.
- **Employee selection in forms** provides candidates for owners, responsible people and similar fields. It does not open accounts, timesheets or the company chart.

## Administration

One card contains independent capabilities:

- **View user accounts** opens the directory, profile details and roles. No password or profile changes, and no timesheet access.
- **Manage user accounts** allows creation, editing, password resets and deletion. The UI also requires account viewing. Only administrators may assign roles.
- **Roles and permissions** allows full role and individual permission configuration, including your own. It is an administrative capability, not a read-only mode. It also opens profiles needed for permission editing. It does not allow password resets or template changes by itself.
- **New-project template** allows viewing and configuring processes and tasks automatically created with a project, independently of role management. Legacy read-only access remains read-only until configuration is explicitly granted.
- **Edit timesheet day types** allows creating, editing and deleting day labels. The dictionary opens with Day types inside the timesheet; there is no separate page. Viewing day types is also required. Dictionary-only administrators do not see employees or their calendars. It does not allow changing employee calendars.
- **View company structure** opens the reporting hierarchy without logins, passwords or timesheet entries. It does not allow manager changes; those require account editing.
- **View activity log** opens user activity history; request and response bodies may contain operational data. It grants no other administrative access.

Choose Available or No access for each common setting. Mixed permissions show the individual saved actions. Choosing a common setting replaces only its own actions and preserves unrelated permissions.

## Saving

Save applies role changes. Cancel discards unsaved changes. The page reset restores built-in defaults after confirmation.

Administrators always retain full access. Permissions are enforced on the server; hidden pages and controls are additional UI checks.
