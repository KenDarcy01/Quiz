"""Picture questions: guess the flag. Images are in media/flags (from flag-icons, MIT licence).

Each tier is a difficulty grade: 1 = flags most children know, 5 = very hard.
"""

TOPIC = 'Flags'
PROMPT = "Which country's flag is this?"

TIERS = {
    1: 'ie gb us fr it de es jp ca br cn au gb-eng gb-sct gb-wls ch kr in mx',
    2: 'nl be pt se no dk fi pl gr tr ru ar za nz eg jm ua at is ng ke sa il',
    3: 'hr cz hu ro bg rs sk si ee lv lt lu mt cy co cl pe cu ve ma tn pk th vn id ph my sg ir iq gh et',
    4: 'al ba me mk md by ge am az kz uz bo py uy ec cr pa do ht np bd lk mn kp af sy jo lb dz ly sn cm ci '
       'tz ug zw zm ao mz mg qa ae kw',
    5: 'li ad sm mc va bt la kh mm bn tl fj pg ws to vu sb ki tv nr mh fm pw bf ml ne td sd ss er dj so rw bi '
       'mw ls sz bw na gq ga cg cd cf gn gw sl lr tg bj mr cv st km sc mu kg tj tm om ye bh gy sr bz gt sv hn '
       'ni tt bb lc vc gd ag dm kn bs',
}

# Everyday names where the flag-icons name is formal.
NAMES = {
    'us': 'USA', 'gb': 'United Kingdom', 'tr': 'Turkey', 'cz': 'Czechia', 'bn': 'Brunei', 'cv': 'Cape Verde',
    'ci': 'Ivory Coast', 'cd': 'DR Congo', 'cg': 'Congo', 'va': 'Vatican City', 'fm': 'Micronesia',
    'st': 'São Tomé and Príncipe', 'kr': 'South Korea', 'kp': 'North Korea',
}
