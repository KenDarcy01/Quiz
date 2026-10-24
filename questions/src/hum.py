"""Hum-it questions: one player's phone secretly shows a song, they hum it (no words!) and everyone
else races to guess. Grade 1 = songs young children know, 5 = hard. (title, artist or film)
"""

TOPIC = 'Hum it'
PROMPT = 'Hum it!'

SONGS = {
    1: [('Happy Birthday', ''), ('Twinkle Twinkle Little Star', ''), ('Jingle Bells', ''),
        ('Baby Shark', ''), ('Old MacDonald Had a Farm', ''), ('The Wheels on the Bus', ''),
        ('Let It Go', 'Frozen'), ('Star Wars theme', ''), ('Head, Shoulders, Knees and Toes', ''),
        ("If You're Happy and You Know It", ''), ('Row, Row, Row Your Boat', ''), ('Rudolph the Red-Nosed Reindeer', '')],
    2: [('We Will Rock You', 'Queen'), ('Happy', 'Pharrell Williams'), ('Shake It Off', 'Taylor Swift'),
        ('Hakuna Matata', 'The Lion King'), ('Under the Sea', 'The Little Mermaid'),
        ("We Don't Talk About Bruno", 'Encanto'), ("How Far I'll Go", 'Moana'),
        ("You've Got a Friend in Me", 'Toy Story'), ('Ghostbusters', 'Ray Parker Jr.'),
        ("Hedwig's Theme", 'Harry Potter'), ('Jaws theme', ''), ('The Pink Panther theme', ''),
        ('Mission: Impossible theme', ''), ("Can't Stop the Feeling!", 'Justin Timberlake'),
        ('Y.M.C.A.', 'Village People'), ('Barbie Girl', 'Aqua')],
    3: [('Bohemian Rhapsody', 'Queen'), ('Uptown Funk', 'Mark Ronson ft. Bruno Mars'),
        ('Shape of You', 'Ed Sheeran'), ('Dancing Queen', 'ABBA'), ('Thriller', 'Michael Jackson'),
        ('Billie Jean', 'Michael Jackson'), ('Sweet Caroline', 'Neil Diamond'),
        ("Don't Stop Believin'", 'Journey'), ('Rolling in the Deep', 'Adele'), ('Bad Guy', 'Billie Eilish'),
        ('Mamma Mia', 'ABBA'), ('Wannabe', 'Spice Girls'), ('I Gotta Feeling', 'The Black Eyed Peas'),
        ('Africa', 'Toto'), ("Livin' on a Prayer", 'Bon Jovi'), ('Galway Girl', 'Ed Sheeran'),
        ('The Final Countdown', 'Europe'), ('Eye of the Tiger', 'Survivor'),
        ('Seven Nation Army', 'The White Stripes')],
    4: [('Zombie', 'The Cranberries'), ('With or Without You', 'U2'), ('Hey Jude', 'The Beatles'),
        ('Yellow Submarine', 'The Beatles'), ('Smells Like Teen Spirit', 'Nirvana'),
        ('Mr. Brightside', 'The Killers'), ('Wonderwall', 'Oasis'), ('Take On Me', 'a-ha'),
        ('Blinding Lights', 'The Weeknd'), ('Flowers', 'Miley Cyrus'), ('As It Was', 'Harry Styles'),
        ('Someone Like You', 'Adele'), ("Hips Don't Lie", 'Shakira'), ('Umbrella', 'Rihanna'),
        ('Toxic', 'Britney Spears'), ('Gangnam Style', 'PSY'), ('Despacito', 'Luis Fonsi'),
        ('Levitating', 'Dua Lipa'), ('Bad Romance', 'Lady Gaga'), ('Rasputin', 'Boney M.')],
    5: [('Fairytale of New York', 'The Pogues'), ('The Fields of Athenry', ''),
        ('Whiskey in the Jar', 'Thin Lizzy'), ('Riptide', 'Vance Joy'), ('Take Me to Church', 'Hozier'),
        ('Space Oddity', 'David Bowie'), ('Waterloo', 'ABBA'), ('Hotel California', 'Eagles'),
        ('Linger', 'The Cranberries'), ('Teenage Kicks', 'The Undertones'), ('Common People', 'Pulp'),
        ('Valerie', 'Amy Winehouse'), ('Somebody That I Used to Know', 'Gotye'),
        ('Running Up That Hill', 'Kate Bush'), ('Dreams', 'Fleetwood Mac'),
        ("Sweet Child o' Mine", "Guns N' Roses"), ('Ring of Fire', 'Johnny Cash')],
}

# Films, not artists: these songs are hum-it only.
NOT_ARTISTS = {'Frozen', 'The Lion King', 'The Little Mermaid', 'Encanto', 'Moana', 'Toy Story', 'Harry Potter'}
