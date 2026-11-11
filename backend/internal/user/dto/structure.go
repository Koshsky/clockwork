package dto

// StructureUserResponse is the public business profile needed by the chart.
type StructureUserResponse struct {
	ID         int64   `json:"id"`
	Name       string  `json:"name"`
	LastName   string  `json:"last_name"`
	FirstName  string  `json:"first_name"`
	MiddleName *string `json:"middle_name"`
	ManagerID  *int64  `json:"manager_id"`
	Position   string  `json:"position"`
	Preset     *string `json:"preset"`
}
