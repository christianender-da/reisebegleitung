-- reisebegleitung 0.3: Check-in je Zug (JSON: { checkins: [{leg, at}], missed: [{leg, at}] })
ALTER TABLE journey_trips ADD COLUMN boarding TEXT NOT NULL DEFAULT '{"checkins":[],"missed":[]}';
