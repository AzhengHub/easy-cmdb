package cmdb

import (
	"context"
	"errors"
	"testing"
)

func TestRackPlacementFaces(t *testing.T) {
	db := testDB(t)
	ctx := context.Background()

	room, err := SaveRoom(ctx, db, 0, RoomFields{Name: "lab-room", Columns: 6, Rows: 6}, 0, "tester")
	if err != nil {
		t.Fatalf("create room: %v", err)
	}
	rack, err := SaveRack(ctx, db, 0, room.ID, RackFields{Name: "R01", HeightU: 42, Column: 1, Row: 1}, 0, "tester")
	if err != nil {
		t.Fatalf("create rack: %v", err)
	}
	hosts := make([]Asset, 4)
	for index := range hosts {
		hosts[index], err = SaveAsset(ctx, db, 0, 0, baseFields("host", "face-host-"+string(rune('a'+index))), "tester")
		if err != nil {
			t.Fatalf("create host %d: %v", index, err)
		}
	}

	frontHalf, err := SavePlacement(ctx, db, hosts[0].ID, nil, PlacementFields{
		RackID: rack.ID, StartU: 1, Units: 1, Face: "front", Depth: "half",
	}, 0, "tester")
	if err != nil {
		t.Fatalf("place front half device: %v", err)
	}
	if frontHalf.Face != "front" || frontHalf.Depth != "half" {
		t.Fatalf("unexpected front placement: %+v", frontHalf)
	}
	if _, err := SavePlacement(ctx, db, hosts[1].ID, nil, PlacementFields{
		RackID: rack.ID, StartU: 1, Units: 1, Face: "rear", Depth: "half",
	}, 0, "tester"); err != nil {
		t.Fatalf("rear half device should share a unit: %v", err)
	}
	if _, err := SavePlacement(ctx, db, hosts[2].ID, nil, PlacementFields{
		RackID: rack.ID, StartU: 1, Units: 1, Face: "front", Depth: "full",
	}, 0, "tester"); !errors.Is(err, ErrInvalid) {
		t.Fatalf("full-depth conflict error = %v, want ErrInvalid", err)
	}
	if _, err := SavePlacement(ctx, db, hosts[2].ID, nil, PlacementFields{
		RackID: rack.ID, StartU: 2, Units: 1, Face: "rear", Depth: "full",
	}, 0, "tester"); err != nil {
		t.Fatalf("place full-depth device: %v", err)
	}
	if _, err := SavePlacement(ctx, db, hosts[0].ID, nil, PlacementFields{
		RackID: rack.ID, StartU: 2, Units: 1, Face: "front", Depth: "half",
	}, frontHalf.Version, "tester"); !errors.Is(err, ErrInvalid) {
		t.Fatalf("move into full-depth unit error = %v, want ErrInvalid", err)
	}
	moved, err := SavePlacement(ctx, db, hosts[0].ID, nil, PlacementFields{
		RackID: rack.ID, StartU: 3, Units: 1, Face: "front", Depth: "half",
	}, frontHalf.Version, "tester")
	if err != nil {
		t.Fatalf("move front half device: %v", err)
	}
	if moved.StartU != 3 || moved.Face != "front" || moved.Depth != "half" {
		t.Fatalf("unexpected moved placement: %+v", moved)
	}
	defaulted, err := SavePlacement(ctx, db, hosts[3].ID, nil, PlacementFields{
		RackID: rack.ID, StartU: 4, Units: 1,
	}, 0, "tester")
	if err != nil {
		t.Fatalf("place defaulted device: %v", err)
	}
	if defaulted.Face != "front" || defaulted.Depth != "full" {
		t.Fatalf("defaults = %+v, want front/full", defaulted)
	}

	layout, err := ListFacilities(ctx, db)
	if err != nil {
		t.Fatalf("list facilities: %v", err)
	}
	if len(layout.Placements) != 4 {
		t.Fatalf("placements = %d, want 4", len(layout.Placements))
	}
}
